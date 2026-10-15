import { randomUUID } from "node:crypto";

import { Clock, Context, Effect, FileSystem, Layer, Path, Schema, Semaphore } from "effect";
import { ChildProcess, ChildProcessSpawner } from "effect/process";

import type { ToolProgress, ToolStatus } from "../../src/lib/native/types";
import {
  type FileError,
  fileError,
  mapFileError,
  ToolChecksumMismatch,
  ToolDownloadFailed,
  ToolUnsupported,
} from "../errors";
import { AppLog } from "../services/app-log";
import { Downloads } from "./downloads";
import { latestRelease, type Platform, TOOL_LABELS, TOOL_NAMES, type ToolName, type ToolRelease } from "./sources";
import { isZip, unzip } from "./unzip";

/** How long an installed version is used before checking for a newer one. yt-dlp has to keep up with YouTube. */
export const CHECK_INTERVAL: Record<ToolName, number> = {
  "yt-dlp": 24 * 60 * 60 * 1000,
  quickjs: 30 * 24 * 60 * 60 * 1000,
  ffmpeg: 30 * 24 * 60 * 60 * 1000,
};

/**
 * `tools/<tool>/current.json`: the installed version, its executables (relative to the tool
 * folder) and the files it was installed from. When the files change for the same version (a
 * different build of it), the tool is installed again.
 */
const Manifest = Schema.fromJsonString(
  Schema.Struct({
    version: Schema.String,
    checkedAt: Schema.Number,
    executables: Schema.Record(Schema.String, Schema.String),
    sources: Schema.optional(Schema.Array(Schema.String)),
  }),
);
type Manifest = typeof Manifest.Type;

export type ToolError = ToolDownloadFailed | ToolChecksumMismatch | ToolUnsupported | FileError;

/** Executable name (e.g. "ffprobe") to absolute path. */
export type ToolPaths = Record<string, string>;

interface ToolsShape {
  /** Where the tools are installed; tools may keep caches here too. */
  readonly folder: string;
  readonly status: Effect.Effect<ToolStatus[]>;
  /**
   * Makes sure `tools` are installed and recent enough, downloading or updating them as needed,
   * and returns their executables. With `force`, checks for a newer version even if the last
   * check was recent (after yt-dlp failed, for example). An update that can't be reached keeps
   * the installed version.
   */
  readonly ensure: (
    tools: readonly ToolName[],
    options?: { force?: boolean; onProgress?: (progress: ToolProgress) => Effect.Effect<void> },
  ) => Effect.Effect<Record<ToolName, ToolPaths>, ToolError>;
}

/** The download tools behind YouTube projects, kept in the app's data folder. */
export class Tools extends Context.Service<Tools, ToolsShape>()("studio/Tools") {}

const decodeManifest = Schema.decodeUnknownEffect(Manifest);

/** The files a release is installed from. */
const sourcesOf = (release: ToolRelease) => release.downloads.map((download) => download.url);
const encodeManifest = Schema.encodeSync(Manifest);

export function toolsLayer(options: { folder: string; platform: Platform }) {
  return Layer.effect(
    Tools,
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const paths = yield* Path.Path;
      const downloads = yield* Downloads;
      const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
      const log = yield* AppLog;
      const locks = Object.fromEntries(
        yield* Effect.forEach(TOOL_NAMES, (tool) => Effect.map(Semaphore.make(1), (lock) => [tool, lock] as const)),
      ) as Record<ToolName, Semaphore.Semaphore>;

      const toolFolder = (tool: ToolName) => paths.join(options.folder, tool);
      const manifestFile = (tool: ToolName) => paths.join(toolFolder(tool), "current.json");

      const readManifest = (tool: ToolName) =>
        fs.readFileString(manifestFile(tool)).pipe(
          Effect.flatMap((text) => decodeManifest(text)),
          Effect.option,
        );

      const writeManifest = (tool: ToolName, manifest: Manifest) => {
        const temporary = `${manifestFile(tool)}.${randomUUID().slice(0, 8)}.tmp`;
        return fs
          .writeFileString(temporary, encodeManifest(manifest))
          .pipe(
            Effect.andThen(fs.rename(temporary, manifestFile(tool))),
            mapFileError(`the ${TOOL_LABELS[tool]} settings`, "save"),
          );
      };

      /** The manifest's executables as absolute paths, if they all still exist. */
      const installedPaths = (tool: ToolName, manifest: Manifest) =>
        Effect.gen(function* () {
          const resolved: ToolPaths = {};
          for (const [name, relative] of Object.entries(manifest.executables)) {
            const absolute = paths.join(toolFolder(tool), relative);
            if (!(yield* fs.exists(absolute).pipe(Effect.orElseSucceed(() => false)))) return undefined;
            resolved[name] = absolute;
          }
          return resolved;
        });

      /**
       * Unpacks an archive: zip files ourselves (Linux's GNU tar can't read them), tar.xz with
       * `tar`. Whether it worked.
       */
      const unpack = (file: string, folder: string) =>
        Effect.gen(function* () {
          const head = yield* fs.readFile(file).pipe(Effect.map((bytes) => bytes.subarray(0, 4)));
          if (isZip(head)) {
            return yield* Effect.tryPromise(() => unzip(file, folder)).pipe(
              Effect.as(true),
              Effect.orElseSucceed(() => false),
            );
          }
          return (yield* spawner.exitCode(ChildProcess.make("tar", ["-xf", file, "-C", folder]))) === 0;
        });

      /** Finds a file named `name` anywhere under `folder`. */
      const findFile = (folder: string, name: string) =>
        fs.readDirectory(folder, { recursive: true }).pipe(
          Effect.map((entries) => entries.find((entry) => paths.basename(entry) === name)),
          Effect.map((entry) => (entry === undefined ? undefined : paths.join(folder, entry))),
        );

      const install = (release: ToolRelease, onProgress: (progress: ToolProgress) => Effect.Effect<void>) =>
        Effect.gen(function* () {
          const tool = release.tool;
          const label = TOOL_LABELS[tool];
          const work = paths.join(toolFolder(tool), `.download-${randomUUID().slice(0, 8)}`);
          const staging = paths.join(work, "install");
          yield* fs.makeDirectory(staging, { recursive: true });

          return yield* Effect.gen(function* () {
            for (const [index, download] of release.downloads.entries()) {
              const file = paths.join(work, `download-${index}`);
              const result = yield* downloads
                .file(download.url, file, (received, total) =>
                  onProgress({ tool, phase: "downloading", received, total }),
                )
                .pipe(
                  Effect.mapError(
                    (error) =>
                      new ToolDownloadFailed({
                        message: `Couldn't download ${label}: ${error.message} Check your internet connection and try again.`,
                      }),
                  ),
                );
              yield* onProgress({ tool, phase: "verifying" });
              if (result.sha256 !== download.sha256) {
                return yield* new ToolChecksumMismatch({
                  message: `The ${label} download doesn't match its published checksum, so it wasn't installed. Try again later.`,
                });
              }

              yield* onProgress({ tool, phase: "installing" });
              let source = file;
              for (const executable of download.executables) {
                if (download.archive) {
                  const unpacked = paths.join(work, `unpacked-${index}`);
                  if (!(yield* fs.exists(unpacked))) {
                    yield* fs.makeDirectory(unpacked, { recursive: true });
                    const unpackedOk = yield* unpack(file, unpacked);
                    if (!unpackedOk) {
                      return yield* new ToolDownloadFailed({ message: `Couldn't unpack ${label}. Try again later.` });
                    }
                  }
                  const found = yield* findFile(unpacked, executable.from);
                  if (!found) {
                    return yield* new ToolDownloadFailed({
                      message: `The ${label} download doesn't contain ${executable.from}. Try again later.`,
                    });
                  }
                  source = found;
                }
                if (download.bundle) {
                  // The executable's whole folder, which holds the files it needs.
                  const bundle = paths.join(staging, download.bundle);
                  if (!(yield* fs.exists(bundle))) yield* fs.rename(paths.dirname(source), bundle);
                  yield* fs.chmod(paths.join(bundle, executable.from), 0o755);
                  continue;
                }
                const target = paths.join(staging, executable.as);
                yield* fs.copyFile(source, target);
                yield* fs.chmod(target, 0o755);
              }
            }

            const versionFolder = paths.join(toolFolder(tool), release.version);
            yield* fs.remove(versionFolder, { recursive: true, force: true });
            yield* fs.rename(staging, versionFolder);
            const manifest: Manifest = {
              version: release.version,
              checkedAt: yield* Clock.currentTimeMillis,
              executables: Object.fromEntries(
                release.downloads.flatMap((download) =>
                  download.executables.map((executable) => [
                    executable.as.replace(/\.exe$/, ""),
                    download.bundle
                      ? paths.join(release.version, download.bundle, executable.from)
                      : paths.join(release.version, executable.as),
                  ]),
                ),
              ),
              sources: sourcesOf(release),
            };
            yield* writeManifest(tool, manifest);

            // macOS checks a program the first time it runs, which takes yt-dlp ten seconds; doing
            // that now keeps it out of the first YouTube lookup.
            if (tool === "yt-dlp") {
              for (const relative of Object.values(manifest.executables)) {
                yield* spawner
                  .exitCode(ChildProcess.make(paths.join(toolFolder(tool), relative), ["--version"]))
                  .pipe(Effect.timeout("2 minutes"), Effect.ignore);
              }
            }

            // Older versions are no longer used; failing to remove one doesn't matter.
            const entries = yield* fs.readDirectory(toolFolder(tool)).pipe(Effect.orElseSucceed(() => []));
            yield* Effect.forEach(
              entries.filter(
                (entry) => entry !== release.version && entry !== "current.json" && !entry.startsWith("."),
              ),
              (entry) => fs.remove(paths.join(toolFolder(tool), entry), { recursive: true }).pipe(Effect.ignore),
            );
            return manifest;
          }).pipe(Effect.ensuring(fs.remove(work, { recursive: true, force: true }).pipe(Effect.ignore)));
        }).pipe(
          Effect.catchTag("PlatformError", (error) =>
            Effect.fail(fileError(TOOL_LABELS[release.tool], "install")(error)),
          ),
        );

      const ensureOne = (
        tool: ToolName,
        force: boolean,
        onProgress: (progress: ToolProgress) => Effect.Effect<void>,
      ): Effect.Effect<ToolPaths, ToolError> =>
        locks[tool].withPermits(1)(
          Effect.gen(function* () {
            const now = yield* Clock.currentTimeMillis;
            const installed = yield* readManifest(tool);
            const current = installed._tag === "Some" ? yield* installedPaths(tool, installed.value) : undefined;
            // Installs from before the manifest named its sources are checked (and updated) right away.
            const fresh =
              installed._tag === "Some" &&
              installed.value.sources !== undefined &&
              now - installed.value.checkedAt < CHECK_INTERVAL[tool] &&
              !force;
            if (current && fresh) return current;

            yield* onProgress({ tool, phase: "checking" });
            const release = yield* latestRelease(tool, options.platform).pipe(
              Effect.provideService(Downloads, downloads),
              Effect.result,
            );
            if (release._tag === "Failure") {
              // Offline or the source is down: an installed version keeps working until the next check.
              if (current) {
                yield* log.write("WARN", "tools", `Update check for ${tool} failed: ${release.failure.message}`);
                return current;
              }
              return yield* release.failure;
            }
            if (
              current &&
              installed._tag === "Some" &&
              installed.value.version === release.success.version &&
              installed.value.sources?.join("\n") === sourcesOf(release.success).join("\n")
            ) {
              yield* writeManifest(tool, { ...installed.value, checkedAt: now });
              return current;
            }
            const manifest = yield* install(release.success, onProgress);
            yield* log.write("INFO", "tools", `Installed ${tool} ${manifest.version}`);
            return (yield* installedPaths(tool, manifest)) ?? {};
          }),
        );

      return {
        folder: options.folder,
        status: Effect.forEach(TOOL_NAMES, (tool) =>
          Effect.map(readManifest(tool), (manifest) => ({
            tool,
            version: manifest._tag === "Some" ? manifest.value.version : null,
            checkedAt: manifest._tag === "Some" ? manifest.value.checkedAt : null,
          })),
        ),
        ensure: (tools, ensureOptions = {}) =>
          Effect.gen(function* () {
            const result = {} as Record<ToolName, ToolPaths>;
            for (const tool of tools) {
              result[tool] = yield* ensureOne(
                tool,
                ensureOptions.force ?? false,
                ensureOptions.onProgress ?? (() => Effect.void),
              );
            }
            return result;
          }),
      } satisfies ToolsShape;
    }),
  );
}

/**
 * Updating Tune Studio from its GitHub releases: the published release's signed `latest.json` (`manifest.ts`) names
 * the installers. A draft isn't "latest", so publishing a release is what offers it. The renderer asks once per run
 * (`announce`, shown by the first window that asks) or from the settings (`check`), downloads with progress, then
 * restarts: quitting saves every page as usual, and main installs the staged update last (`install.ts`).
 */
import { Context, Effect, FileSystem, Layer, Path, Schema, Semaphore } from "effect";

import { UpdateFailed } from "../../src/lib/errors";
import type { AvailableUpdate, Progress } from "../../src/lib/native/types";
import { DOWNLOADING_THE_UPDATE } from "../../src/lib/steps";
import { REPOSITORY } from "../identity";
import { AppLog } from "../services/app-log";
import { Downloads } from "../tools/downloads";
import { type Installation, prepare, type Staged } from "./install";
import { isNewer, UpdateManifest, type UpdateTarget, verifySignature } from "./manifest";

/** Where the release files come from (the download link redirects to GitHub's asset storage). */
export const UPDATE_HOSTS = ["github.com", "objects.githubusercontent.com", "release-assets.githubusercontent.com"];

/** Redirects to the latest published release's page, `…/releases/tag/<tag>`. */
const LATEST = `https://github.com/${REPOSITORY}/releases/latest`;
const releasePage = (version: string) => `https://github.com/${REPOSITORY}/releases/tag/v${version}`;
const assetUrl = (version: string, name: string) =>
  `https://github.com/${REPOSITORY}/releases/download/v${version}/${encodeURIComponent(name)}`;

const decodeManifest = Schema.decodeUnknownEffect(Schema.fromJsonString(UpdateManifest));

interface UpdatesShape {
  /**
   * The latest release when it is newer than this version, else null. The answer is kept for the run: `force` asks
   * GitHub again (the settings' button). Failing to ask is an `UpdateFailed` only when forced; otherwise there is
   * simply no update.
   */
  readonly check: (options: { force: boolean }) => Effect.Effect<AvailableUpdate | null, UpdateFailed>;
  /** The update to tell the user about at start: the first window that asks gets it, the others null. */
  readonly announce: Effect.Effect<AvailableUpdate | null>;
  /** Downloads and checks the update `check` found, so `restart` can install it. */
  readonly download: (onProgress: (progress: Progress) => Effect.Effect<void>) => Effect.Effect<void, UpdateFailed>;
  /** Quits to install the downloaded update; the new version starts afterwards. */
  readonly restart: Effect.Effect<void, UpdateFailed>;
  /** The downloaded update main installs while quitting, once `restart` asked for it. */
  readonly staged: Effect.Effect<Staged | null>;
}

export class Updates extends Context.Service<Updates, UpdatesShape>()("studio/Updates") {}

export interface UpdatesOptions {
  /** Where downloads are kept until they are installed (emptied at start). */
  folder: string;
  /** This app's version. */
  version: string;
  /** Which installer this system takes; null where there is none (another processor, say). */
  target: UpdateTarget | null;
  /** How this copy was installed. */
  installation: Installation;
  /** The release key's public half (raw, base64); without one (development, tests) there are never updates. */
  publicKey: string;
  /** Quits the app (which then installs `staged`). */
  quit: () => void;
}

const failed = (message: string) => new UpdateFailed({ message });

export function updatesLayer(options: UpdatesOptions) {
  return Layer.effect(
    Updates,
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const paths = yield* Path.Path;
      const downloads = yield* Downloads;
      const log = yield* AppLog;
      const lock = yield* Semaphore.make(1);

      // A download a quit cut off, or one installed already.
      yield* fs.remove(options.folder, { recursive: true }).pipe(Effect.ignore);

      let found: { update: AvailableUpdate; manifest: UpdateManifest } | null | undefined;
      let announced = false;
      let staged: { version: string; staged: Staged } | null = null;
      /** Set by `restart`: only then does quitting install the staged update. */
      let restarting = false;

      const ask = Effect.gen(function* () {
        if (!options.publicKey) return null;
        // The feed and its signature of one release, even when another is published in between.
        const tag = /\/releases\/tag\/(v[^/?#]+)$/.exec(yield* downloads.redirect(LATEST))?.[1];
        if (!tag) return null;
        const text = yield* downloads.text(assetUrl(tag.slice(1), "latest.json"));
        const signature = yield* downloads.text(assetUrl(tag.slice(1), "latest.json.sig"));
        if (!verifySignature(Buffer.from(text, "utf8"), signature, options.publicKey))
          return yield* Effect.fail(failed("The update's signature isn't valid."));
        const manifest = yield* decodeManifest(text);
        if (`v${manifest.version}` !== tag) return yield* Effect.fail(failed("The update doesn't match its release."));
        if (!isNewer(manifest.version, options.version)) return null;
        const file = options.target ? manifest.files[options.target] : undefined;
        const update: AvailableUpdate = {
          version: manifest.version,
          page: releasePage(manifest.version),
          installable: Boolean(file) && options.installation.kind !== "manual",
        };
        return { update, manifest };
      });

      const check = ({ force }: { force: boolean }) =>
        Effect.gen(function* () {
          if (found !== undefined && !force) return found?.update ?? null;
          const result = yield* ask.pipe(
            Effect.tapError((error) => log.write("WARN", "updates", `Checking for updates: ${error.message}`)),
            Effect.mapError((error) =>
              error instanceof UpdateFailed
                ? error
                : failed("Tune Studio couldn't check for updates. Check your internet connection and try again."),
            ),
          );
          found = result;
          return result?.update ?? null;
        });

      const download = (onProgress: (progress: Progress) => Effect.Effect<void>) =>
        lock.withPermits(1)(
          Effect.gen(function* () {
            const update = found;
            const target = options.target;
            const installation = options.installation;
            if (!update || !target || installation.kind === "manual" || !update.update.installable)
              return yield* Effect.fail(failed("There is no update to install."));
            const { version } = update.update;
            if (staged?.version === version) return;
            const file = update.manifest.files[target]!;

            const work = paths.join(options.folder, version);
            yield* fs.remove(work, { recursive: true }).pipe(Effect.ignore);
            yield* fs.makeDirectory(work, { recursive: true });
            const into = paths.join(work, file.name);
            const report = (done: number) =>
              onProgress({ step: DOWNLOADING_THE_UPDATE, done, total: file.size, unit: "bytes" });
            yield* report(0);
            const got = yield* downloads.file(assetUrl(version, file.name), into, (received) => report(received), {
              hosts: UPDATE_HOSTS,
              maxBytes: file.size,
            });
            if (got.size !== file.size || got.sha256 !== file.sha256)
              return yield* Effect.fail(failed("The update didn't download correctly. Try again."));
            const ready = yield* Effect.tryPromise({
              try: () => prepare(installation, into, work),
              catch: String,
            }).pipe(
              Effect.tapError((error) => log.write("ERROR", "updates", `Preparing ${version}: ${error}`)),
              Effect.mapError(() => failed("The downloaded update can't be installed.")),
            );
            staged = { version, staged: ready };
          }).pipe(
            Effect.mapError((error) =>
              error instanceof UpdateFailed
                ? error
                : failed("Tune Studio couldn't download the update. Check your internet connection and try again."),
            ),
          ),
        );

      return {
        check,
        announce: Effect.gen(function* () {
          const update = yield* check({ force: false }).pipe(Effect.orElseSucceed(() => null));
          if (!update || announced) return null;
          announced = true;
          return update;
        }),
        download,
        restart: Effect.suspend(() => {
          if (!staged) return Effect.fail(failed("Download the update first."));
          restarting = true;
          return Effect.sync(options.quit);
        }),
        staged: Effect.sync(() => (restarting ? (staged?.staged ?? null) : null)),
      };
    }),
  );
}

/** No updates at all (tests, and the runtime of a run that isn't the packaged app). */
export const noUpdates = Layer.succeed(Updates, {
  check: () => Effect.succeed(null),
  announce: Effect.succeed(null),
  download: () => Effect.fail(failed("There is no update to install.")),
  restart: Effect.fail(failed("There is no update to install.")),
  staged: Effect.succeed(null),
});

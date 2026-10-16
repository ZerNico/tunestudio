import { Effect, Schema } from "effect";

import type { ToolName } from "../../src/lib/native/types";
import { ToolDownloadFailed, ToolUnsupported } from "../errors";
import { Downloads } from "./downloads";

export type { ToolName };

export const TOOL_NAMES: readonly ToolName[] = ["yt-dlp", "quickjs", "ffmpeg"];

/** How the tools are named for people. */
export const TOOL_LABELS: Record<ToolName, string> = { "yt-dlp": "yt-dlp", quickjs: "QuickJS", ffmpeg: "FFmpeg" };

export interface Platform {
  readonly os: NodeJS.Platform;
  readonly arch: string;
}

/** One file to download, checked against `sha256` before anything uses it. */
export interface ToolDownload {
  readonly url: string;
  readonly sha256: string;
  /** Whether the file is an archive (zip or tar.xz) or the executable itself. */
  readonly archive: boolean;
  /** The executables to install: `from` is the file name inside the archive (ignored otherwise). */
  readonly executables: readonly { readonly from: string; readonly as: string }[];
  /**
   * Keep the archive's folder holding the executable whole, as `<bundle>/`, for programs that
   * need the files next to them (yt-dlp's "onedir" builds). The executable keeps its name.
   */
  readonly bundle?: string;
}

export interface ToolRelease {
  readonly tool: ToolName;
  readonly version: string;
  readonly downloads: readonly ToolDownload[];
}

const GitHubRelease = Schema.Struct({
  tag_name: Schema.String,
  assets: Schema.Array(
    Schema.Struct({
      name: Schema.String,
      browser_download_url: Schema.String,
      digest: Schema.optional(Schema.NullOr(Schema.String)),
    }),
  ),
});
type GitHubRelease = typeof GitHubRelease.Type;

const decodeRelease = Schema.decodeUnknownEffect(GitHubRelease);

/** `name.exe` on Windows, `name` elsewhere. */
export function executableName(name: string, platform: Platform): string {
  return platform.os === "win32" ? `${name}.exe` : name;
}

const zip = (asset: string, executable: string) => ({ asset: `${asset}.zip`, executable });

/**
 * The yt-dlp release for a platform: its "onedir" zip and the executable inside. These start in
 * a fraction of a second; the single-file builds unpack themselves on every run, which takes
 * 6 to 13 seconds. The macOS one runs on Intel and Apple Silicon.
 */
export function ytDlpAsset(platform: Platform): { asset: string; executable: string } | undefined {
  if (platform.os === "darwin") return zip("yt-dlp_macos", "yt-dlp_macos");
  if (platform.os === "win32") {
    return {
      x64: zip("yt-dlp_win", "yt-dlp.exe"),
      ia32: zip("yt-dlp_win_x86", "yt-dlp_x86.exe"),
      arm64: zip("yt-dlp_win_arm64", "yt-dlp_arm64.exe"),
    }[platform.arch];
  }
  if (platform.os === "linux") {
    return {
      x64: zip("yt-dlp_linux", "yt-dlp_linux"),
      arm64: zip("yt-dlp_linux_aarch64", "yt-dlp_linux_aarch64"),
    }[platform.arch];
  }
  return undefined;
}

/** The QuickJS-ng file for a platform. Windows on ARM runs the x64 build. */
export function quickJsAsset(platform: Platform): string | undefined {
  if (platform.os === "darwin") return { arm64: "qjs-darwin-arm64", x64: "qjs-darwin-x86_64" }[platform.arch];
  if (platform.os === "win32") {
    return { x64: "qjs-windows-x86_64.exe", arm64: "qjs-windows-x86_64.exe", ia32: "qjs-windows-x86.exe" }[
      platform.arch
    ];
  }
  if (platform.os === "linux") return { x64: "qjs-linux-x86_64", arm64: "qjs-linux-aarch64" }[platform.arch];
  return undefined;
}

/** BtbN's name for a platform, for Windows and Linux FFmpeg builds. */
function btbnTarget(platform: Platform): string | undefined {
  if (platform.os === "win32") return { x64: "win64", arm64: "winarm64" }[platform.arch];
  if (platform.os === "linux") return { x64: "linux64", arm64: "linuxarm64" }[platform.arch];
  return undefined;
}

/** Compares dotted version numbers, e.g. 8.1 and 9.0. */
function compareVersions(a: string, b: string): number {
  const left = a.split(".").map(Number);
  const right = b.split(".").map(Number);
  for (let index = 0; index < Math.max(left.length, right.length); index++) {
    const difference = (left[index] ?? 0) - (right[index] ?? 0);
    if (difference !== 0) return difference;
  }
  return 0;
}

/**
 * The newest release-branch LGPL build in BtbN's rolling "latest" release, e.g.
 * `ffmpeg-n8.1-latest-win64-lgpl-8.1.zip`.
 */
export function btbnAsset(release: GitHubRelease, target: string) {
  const pattern = new RegExp(`^ffmpeg-n(\\d+(?:\\.\\d+)*)-latest-${target}-lgpl-\\1\\.(zip|tar\\.xz)$`);
  const versionOf = (name: string) => pattern.exec(name)?.[1];
  return release.assets
    .filter((asset) => versionOf(asset.name) !== undefined)
    .toSorted((a, b) => compareVersions(versionOf(b.name)!, versionOf(a.name)!))
    .map((asset) => ({ asset, version: versionOf(asset.name)! }))[0];
}

/** `sha256:<hex>` from GitHub's asset digest, or undefined. */
export function githubSha256(digest: string | null | undefined): string | undefined {
  const match = /^sha256:([0-9a-f]{64})$/i.exec(digest ?? "");
  return match?.[1]?.toLowerCase();
}

/** The version in a Martin Riedl download path, e.g. `/download/macos/arm64/1789931890_9.0.2/ffmpeg.zip`. */
export function riedlVersion(url: string): string | undefined {
  return /\/\d+_([\w.-]+)\/[^/]+$/.exec(new URL(url).pathname)?.[1];
}

const unsupported = (tool: ToolName, platform: Platform) =>
  new ToolUnsupported({
    message: `${TOOL_LABELS[tool]} isn't available for ${platform.os} on ${platform.arch}, so YouTube downloads can't work on this computer.`,
  });

const unreachable = (tool: ToolName) => (error: { message: string }) =>
  new ToolDownloadFailed({
    message: `Couldn't check for ${TOOL_LABELS[tool]}: ${error.message} Check your internet connection and try again.`,
  });

const latestGitHub = (tool: ToolName, repo: string) =>
  Downloads.use((downloads) => downloads.json(`https://api.github.com/repos/${repo}/releases/latest`)).pipe(
    Effect.flatMap((json) => decodeRelease(json)),
    Effect.mapError(unreachable(tool)),
  );

const githubDownload = (
  tool: ToolName,
  release: GitHubRelease,
  name: string,
  executables: ToolDownload["executables"],
  archive = false,
  bundle?: string,
) =>
  Effect.gen(function* () {
    const asset = release.assets.find((candidate) => candidate.name === name);
    const sha256 = githubSha256(asset?.digest);
    if (!asset || !sha256) {
      return yield* new ToolDownloadFailed({
        message: `${TOOL_LABELS[tool]} has no download for this computer yet. Try again later.`,
      });
    }
    return {
      url: asset.browser_download_url,
      sha256,
      archive,
      executables,
      ...(bundle ? { bundle } : {}),
    } satisfies ToolDownload;
  });

/** The newest release of `tool` for `platform`, with everything needed to verify it. */
export function latestRelease(tool: ToolName, platform: Platform) {
  return Effect.gen(function* () {
    if (tool === "yt-dlp") {
      const found = ytDlpAsset(platform);
      if (!found) return yield* unsupported(tool, platform);
      const release = yield* latestGitHub(tool, "yt-dlp/yt-dlp");
      const download = yield* githubDownload(
        tool,
        release,
        found.asset,
        [{ from: found.executable, as: "yt-dlp" }],
        true,
        "yt-dlp",
      );
      return { tool, version: release.tag_name, downloads: [download] } satisfies ToolRelease;
    }

    if (tool === "quickjs") {
      const name = quickJsAsset(platform);
      if (!name) return yield* unsupported(tool, platform);
      const release = yield* latestGitHub(tool, "quickjs-ng/quickjs");
      const download = yield* githubDownload(tool, release, name, [
        { from: name, as: executableName("qjs", platform) },
      ]);
      return { tool, version: release.tag_name.replace(/^v/, ""), downloads: [download] } satisfies ToolRelease;
    }

    if (platform.os === "darwin") {
      const arch = { arm64: "arm64", x64: "amd64" }[platform.arch];
      if (!arch) return yield* unsupported(tool, platform);
      const downloads = yield* Downloads;
      const files = yield* Effect.forEach(["ffmpeg", "ffprobe"], (name) =>
        Effect.gen(function* () {
          const url = yield* downloads.redirect(
            `https://ffmpeg.martin-riedl.de/redirect/latest/macos/${arch}/release/${name}.zip`,
          );
          const sha256 = (yield* downloads.text(`${url}.sha256`)).trim().split(/\s+/)[0]?.toLowerCase() ?? "";
          return { name, url, sha256 };
        }).pipe(Effect.mapError(unreachable(tool))),
      );
      const version = riedlVersion(files[0]!.url);
      if (!version || files.some((file) => !/^[0-9a-f]{64}$/.test(file.sha256))) {
        return yield* new ToolDownloadFailed({
          message: "The FFmpeg download for macOS couldn't be verified. Try again later.",
        });
      }
      return {
        tool,
        version,
        downloads: files.map((file) => ({
          url: file.url,
          sha256: file.sha256,
          archive: true,
          executables: [{ from: file.name, as: file.name }],
        })),
      } satisfies ToolRelease;
    }

    const target = btbnTarget(platform);
    if (!target) return yield* unsupported(tool, platform);
    const release = yield* latestGitHub(tool, "BtbN/FFmpeg-Builds");
    const found = btbnAsset(release, target);
    if (!found) return yield* unsupported(tool, platform);
    const download = yield* githubDownload(
      tool,
      release,
      found.asset.name,
      ["ffmpeg", "ffprobe"].map((name) => ({
        from: executableName(name, platform),
        as: executableName(name, platform),
      })),
      true,
    );
    return { tool, version: found.version, downloads: [download] } satisfies ToolRelease;
  });
}

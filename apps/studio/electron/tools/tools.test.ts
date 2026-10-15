import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs";
import http from "node:http";
import path from "node:path";

import { NodeServices } from "@effect/platform-node";
import { afterEach, describe, expect, it } from "@effect/vitest";
import { Effect, Layer } from "effect";
import { TestClock } from "effect/testing";

import type { ToolProgress } from "../../src/lib/native/types";
import { AppLog } from "../services/app-log";
import { tempDir, zipOf } from "../testing";
import { type DownloadLimits, DownloadFailed, Downloads, downloadsLayer } from "./downloads";
import { btbnAsset, latestRelease, quickJsAsset, riedlVersion, ytDlpAsset } from "./sources";
import { CHECK_INTERVAL, Tools, toolsLayer } from "./tools";

let cleanups: (() => void)[] = [];
afterEach(() => {
  for (const cleanup of cleanups.toReversed()) cleanup();
  cleanups = [];
});

const sha256 = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex");

/** A fake executable that prints `output`. */
const script = (output: string) => Buffer.from(`#!/bin/sh\necho ${output}\n`);

/** A yt-dlp "onedir" build, zipped as released: the executable next to the `_internal` folder it needs. */
function ytDlpBuild(output: string): Uint8Array {
  return zipOf([
    { name: "yt-dlp_macos", data: script(output), mode: 0o644 },
    { name: "_internal/" },
    { name: "_internal/Python", data: "python" },
  ]);
}

/**
 * The internet, as far as the tests go: GitHub release JSON and files by URL. `offline` makes
 * every request fail; `requests` records the URLs asked for.
 */
function fakeInternet() {
  const files = new Map<string, Uint8Array>();
  const json = new Map<string, unknown>();
  const state = { offline: false, requests: [] as string[] };
  const fail = (url: string) => new DownloadFailed({ url, message: "No connection." });
  const layer = Layer.succeed(Downloads, {
    json: (url) =>
      Effect.suspend(() => {
        state.requests.push(url);
        return state.offline || !json.has(url) ? Effect.fail(fail(url)) : Effect.succeed(json.get(url));
      }),
    text: (url) => Effect.fail(fail(url)),
    redirect: (url) => Effect.fail(fail(url)),
    file: (url, file, onBytes) =>
      Effect.suspend(() => {
        state.requests.push(url);
        const bytes = files.get(url);
        if (state.offline || !bytes) return Effect.fail(fail(url));
        fs.writeFileSync(file, bytes);
        return Effect.as(onBytes(bytes.byteLength, bytes.byteLength), {
          sha256: sha256(bytes),
          size: bytes.byteLength,
        });
      }),
  });
  /** Publishes a GitHub release of `repo` with these files. */
  const release = (
    repo: string,
    tag: string,
    assets: Record<string, Uint8Array>,
    digests: Record<string, string> = {},
  ) => {
    json.set(`https://api.github.com/repos/${repo}/releases/latest`, {
      tag_name: tag,
      assets: Object.entries(assets).map(([name, bytes]) => {
        const url = `https://github.com/${repo}/releases/download/${tag}/${name}`;
        files.set(url, bytes);
        return { name, browser_download_url: url, digest: `sha256:${digests[name] ?? sha256(bytes)}` };
      }),
    });
  };
  return { layer, release, state };
}

const macOS = { os: "darwin", arch: "arm64" } as const;
const linux = { os: "linux", arch: "x64" } as const;

function setup(platform: { os: NodeJS.Platform; arch: string } = macOS) {
  const { dir, cleanup } = tempDir();
  cleanups.push(cleanup);
  const internet = fakeInternet();
  const lines: string[] = [];
  const log = Layer.succeed(AppLog, {
    write: (level, _target, message) => Effect.sync(() => void lines.push(`${level} ${message}`)),
  });
  const layer = toolsLayer({ folder: path.join(dir, "tools"), platform }).pipe(
    Layer.provide(Layer.mergeAll(internet.layer, log, NodeServices.layer)),
  );
  return { dir, folder: path.join(dir, "tools"), internet, lines, layer };
}

describe("release files per platform", () => {
  it("picks the yt-dlp and QuickJS builds for each operating system and processor", () => {
    expect(ytDlpAsset({ os: "darwin", arch: "x64" })).toEqual({
      asset: "yt-dlp_macos.zip",
      executable: "yt-dlp_macos",
    });
    expect(ytDlpAsset({ os: "win32", arch: "arm64" })).toEqual({
      asset: "yt-dlp_win_arm64.zip",
      executable: "yt-dlp_arm64.exe",
    });
    expect(ytDlpAsset({ os: "linux", arch: "arm64" })).toEqual({
      asset: "yt-dlp_linux_aarch64.zip",
      executable: "yt-dlp_linux_aarch64",
    });
    expect(ytDlpAsset({ os: "freebsd", arch: "x64" })).toBeUndefined();
    expect(quickJsAsset({ os: "darwin", arch: "arm64" })).toBe("qjs-darwin-arm64");
    expect(quickJsAsset({ os: "win32", arch: "arm64" })).toBe("qjs-windows-x86_64.exe");
    expect(quickJsAsset({ os: "linux", arch: "x64" })).toBe("qjs-linux-x86_64");
  });

  it("takes the newest release-branch LGPL FFmpeg build from BtbN", () => {
    const asset = (name: string) => ({ name, browser_download_url: `https://x/${name}`, digest: null });
    const found = btbnAsset(
      {
        tag_name: "latest",
        assets: [
          asset("ffmpeg-master-latest-win64-lgpl.zip"),
          asset("ffmpeg-n7.1-latest-win64-lgpl-7.1.zip"),
          asset("ffmpeg-n8.1-latest-win64-gpl-8.1.zip"),
          asset("ffmpeg-n8.1-latest-win64-lgpl-8.1.zip"),
          asset("ffmpeg-n8.1-latest-linux64-lgpl-8.1.tar.xz"),
        ],
      },
      "win64",
    );
    expect(found?.asset.name).toBe("ffmpeg-n8.1-latest-win64-lgpl-8.1.zip");
    expect(found?.version).toBe("8.1");
  });

  it("reads the version from a macOS FFmpeg download link", () => {
    expect(riedlVersion("https://ffmpeg.martin-riedl.de/download/macos/arm64/1789931890_9.0.2/ffmpeg.zip")).toBe(
      "9.0.2",
    );
  });

  it.effect("refuses a platform without builds with a clear message", () =>
    Effect.gen(function* () {
      const error = yield* Effect.flip(latestRelease("yt-dlp", { os: "freebsd", arch: "x64" }));
      expect(error.message).toBe(
        "yt-dlp isn't available for freebsd on x64, so YouTube downloads can't work on this computer.",
      );
    }).pipe(Effect.provide(fakeInternet().layer)),
  );
});

describe("Tools", () => {
  it.effect("installs yt-dlp and QuickJS, verified, as runnable executables", () => {
    const { internet, folder, layer } = setup();
    internet.release("yt-dlp/yt-dlp", "2026.08.19", { "yt-dlp_macos.zip": ytDlpBuild("yt-dlp 2026.08.19") });
    internet.release("quickjs-ng/quickjs", "v0.17.0", { "qjs-darwin-arm64": script("qjs 0.17.0") });
    return Effect.gen(function* () {
      const progress: ToolProgress[] = [];
      const tools = yield* Tools;
      const installed = yield* tools.ensure(["yt-dlp", "quickjs"], {
        onProgress: (step) => Effect.sync(() => void progress.push(step)),
      });
      // yt-dlp keeps its folder, with the files it needs next to it.
      expect(installed["yt-dlp"]).toEqual({
        "yt-dlp": path.join(folder, "yt-dlp", "2026.08.19", "yt-dlp", "yt-dlp_macos"),
      });
      expect(fs.existsSync(path.join(folder, "yt-dlp", "2026.08.19", "yt-dlp", "_internal", "Python"))).toBe(true);
      expect(installed.quickjs).toEqual({ qjs: path.join(folder, "quickjs", "0.17.0", "qjs") });
      expect(execFileSync(installed["yt-dlp"]["yt-dlp"]!, { encoding: "utf8" }).trim()).toBe("yt-dlp 2026.08.19");
      expect(progress.map((step) => `${step.tool} ${step.phase}`)).toEqual([
        "yt-dlp checking",
        "yt-dlp downloading",
        "yt-dlp verifying",
        "yt-dlp installing",
        "quickjs checking",
        "quickjs downloading",
        "quickjs verifying",
        "quickjs installing",
      ]);
      expect(yield* tools.status).toEqual([
        { tool: "yt-dlp", version: "2026.08.19", checkedAt: 0 },
        { tool: "quickjs", version: "0.17.0", checkedAt: 0 },
        { tool: "ffmpeg", version: null, checkedAt: null },
      ]);
      // Nothing is left over from the download.
      expect(fs.readdirSync(path.join(folder, "yt-dlp")).toSorted()).toEqual(["2026.08.19", "current.json"]);
    }).pipe(Effect.provide(layer));
  });

  it.effect("removes a tool, which is installed again when needed", () => {
    const { internet, folder, layer } = setup();
    internet.release("quickjs-ng/quickjs", "v0.17.0", { "qjs-darwin-arm64": script("qjs 0.17.0") });
    return Effect.gen(function* () {
      const tools = yield* Tools;
      yield* tools.ensure(["quickjs"]);
      yield* tools.remove("quickjs");
      expect(fs.existsSync(path.join(folder, "quickjs"))).toBe(false);
      expect((yield* tools.status).find((entry) => entry.tool === "quickjs")?.version).toBeNull();
      // Removing what isn't there is fine.
      yield* tools.remove("ffmpeg");
      expect((yield* tools.ensure(["quickjs"])).quickjs).toEqual({
        qjs: path.join(folder, "quickjs", "0.17.0", "qjs"),
      });
    }).pipe(Effect.provide(layer));
  });

  it.effect("unpacks ffmpeg and ffprobe from a BtbN archive", () => {
    const { dir, internet, folder, layer } = setup(linux);
    const build = path.join(dir, "build", "ffmpeg-n8.1-latest-linux64-lgpl-8.1", "bin");
    fs.mkdirSync(build, { recursive: true });
    fs.writeFileSync(path.join(build, "ffmpeg"), script("ffmpeg 8.1"));
    fs.writeFileSync(path.join(build, "ffprobe"), script("ffprobe 8.1"));
    const archive = path.join(dir, "ffmpeg.tar.gz");
    execFileSync("tar", ["-czf", archive, "-C", path.join(dir, "build"), "."]);
    internet.release("BtbN/FFmpeg-Builds", "latest", {
      "ffmpeg-n8.1-latest-linux64-lgpl-8.1.tar.xz": fs.readFileSync(archive),
      "ffmpeg-n8.1-latest-win64-lgpl-8.1.zip": Buffer.from("not this one"),
    });
    return Effect.gen(function* () {
      const installed = yield* (yield* Tools).ensure(["ffmpeg"]);
      expect(installed.ffmpeg).toEqual({
        ffmpeg: path.join(folder, "ffmpeg", "8.1", "ffmpeg"),
        ffprobe: path.join(folder, "ffmpeg", "8.1", "ffprobe"),
      });
      expect(execFileSync(installed.ffmpeg.ffprobe!, { encoding: "utf8" }).trim()).toBe("ffprobe 8.1");
    }).pipe(Effect.provide(layer));
  });

  it.effect("installs a tool again when the same version comes from other files", () => {
    const { internet, folder, layer } = setup();
    internet.release("yt-dlp/yt-dlp", "2026.08.19", { "yt-dlp_macos.zip": ytDlpBuild("onedir") });
    // What an older Tune Studio installed: the single-file build, without its sources.
    const old = path.join(folder, "yt-dlp", "2026.08.19");
    fs.mkdirSync(old, { recursive: true });
    fs.writeFileSync(path.join(old, "yt-dlp"), script("onefile"), { mode: 0o755 });
    fs.writeFileSync(
      path.join(folder, "yt-dlp", "current.json"),
      JSON.stringify({ version: "2026.08.19", checkedAt: 0, executables: { "yt-dlp": "2026.08.19/yt-dlp" } }),
    );
    return Effect.gen(function* () {
      const installed = yield* (yield* Tools).ensure(["yt-dlp"]);
      expect(execFileSync(installed["yt-dlp"]["yt-dlp"]!, { encoding: "utf8" }).trim()).toBe("onedir");
    }).pipe(Effect.provide(layer));
  });

  it.effect("refuses a download that doesn't match its checksum and installs nothing", () => {
    const { internet, folder, layer } = setup();
    internet.release(
      "quickjs-ng/quickjs",
      "v0.17.0",
      { "qjs-darwin-arm64": script("tampered") },
      { "qjs-darwin-arm64": "0".repeat(64) },
    );
    return Effect.gen(function* () {
      const error = yield* Effect.flip((yield* Tools).ensure(["quickjs"]));
      expect(error._tag).toBe("ToolChecksumMismatch");
      expect(error.message).toBe(
        "The QuickJS download doesn't match its published checksum, so it wasn't installed. Try again later.",
      );
      expect(fs.readdirSync(path.join(folder, "quickjs"))).toEqual([]);
    }).pipe(Effect.provide(layer));
  });

  it.effect("checks yt-dlp again only after a day, and replaces it when there is a newer one", () => {
    const { internet, folder, layer } = setup();
    internet.release("yt-dlp/yt-dlp", "2026.08.19", { "yt-dlp_macos.zip": ytDlpBuild("old") });
    return Effect.gen(function* () {
      const tools = yield* Tools;
      yield* tools.ensure(["yt-dlp"]);
      const before = internet.state.requests.length;

      yield* TestClock.adjust(CHECK_INTERVAL["yt-dlp"] - 1);
      yield* tools.ensure(["yt-dlp"]);
      expect(internet.state.requests.length).toBe(before);

      // Same version after a day: only the check time moves on.
      yield* TestClock.adjust(2);
      yield* tools.ensure(["yt-dlp"]);
      expect(internet.state.requests.length).toBe(before + 1);
      expect((yield* tools.status)[0]).toMatchObject({
        version: "2026.08.19",
        checkedAt: CHECK_INTERVAL["yt-dlp"] + 1,
      });

      internet.release("yt-dlp/yt-dlp", "2026.09.30", { "yt-dlp_macos.zip": ytDlpBuild("new") });
      const updated = yield* tools.ensure(["yt-dlp"], { force: true });
      expect(execFileSync(updated["yt-dlp"]["yt-dlp"]!, { encoding: "utf8" }).trim()).toBe("new");
      expect(fs.readdirSync(path.join(folder, "yt-dlp")).toSorted()).toEqual(["2026.09.30", "current.json"]);
    }).pipe(Effect.provide(layer));
  });

  it.effect(
    "keeps the installed version when an update check can't connect, and explains a first install offline",
    () => {
      const { internet, lines, layer } = setup();
      internet.release("yt-dlp/yt-dlp", "2026.08.19", { "yt-dlp_macos.zip": ytDlpBuild("installed") });
      return Effect.gen(function* () {
        const tools = yield* Tools;
        yield* tools.ensure(["yt-dlp"]);
        internet.state.offline = true;
        const kept = yield* tools.ensure(["yt-dlp"], { force: true });
        expect(execFileSync(kept["yt-dlp"]["yt-dlp"]!, { encoding: "utf8" }).trim()).toBe("installed");
        expect(lines.at(-1)).toMatch(/^WARN Update check for yt-dlp failed/);

        const error = yield* Effect.flip(tools.ensure(["quickjs"]));
        expect(error.message).toBe(
          "Couldn't check for QuickJS: No connection. Check your internet connection and try again.",
        );
      }).pipe(Effect.provide(layer));
    },
  );
});

describe("downloads", () => {
  /**
   * A local server: `/file` sends bytes, `/stream` sends them without saying how many, `/hop`
   * redirects to `/file`, `/localhost` to `/file` on "localhost", `/away` to another host.
   */
  function server(bytes: Uint8Array) {
    const instance = http.createServer((request, response) => {
      if (request.url === "/hop") return response.writeHead(302, { location: "/file" }).end();
      if (request.url === "/localhost") {
        const port = (instance.address() as { port: number }).port;
        return response.writeHead(302, { location: `http://localhost:${port}/file` }).end();
      }
      if (request.url === "/stream") return response.writeHead(200).end(bytes);
      if (request.url === "/away") return response.writeHead(302, { location: "https://example.com/x" }).end();
      if (request.url === "/file") return response.writeHead(200, { "content-length": bytes.byteLength }).end(bytes);
      response.writeHead(404).end();
    });
    return new Promise<string>((resolve) =>
      instance.listen(0, "127.0.0.1", () => {
        cleanups.push(() => instance.close());
        resolve(`http://127.0.0.1:${(instance.address() as { port: number }).port}`);
      }),
    );
  }

  it("streams a file to disk, hashing it and reporting progress, through allowed redirects", async () => {
    const bytes = Buffer.alloc(300_000, 7);
    const base = await server(bytes);
    const { dir, cleanup } = tempDir();
    cleanups.push(cleanup);
    const seen: number[] = [];
    const result = await Effect.runPromise(
      Downloads.use((downloads) =>
        downloads.file(`${base}/hop`, path.join(dir, "file"), (received) =>
          Effect.sync(() => void seen.push(received)),
        ),
      ).pipe(Effect.provide(downloadsLayer({ hosts: ["127.0.0.1"], allowHttp: true }))),
    );
    expect(result).toEqual({ sha256: sha256(bytes), size: bytes.byteLength });
    expect(seen.at(-1)).toBe(bytes.byteLength);
    expect(fs.readFileSync(path.join(dir, "file")).equals(bytes)).toBe(true);
  });

  it("reports progress a few times a second, not once per network chunk", async () => {
    const bytes = Buffer.alloc(20 * 1024 * 1024, 7);
    const base = await server(bytes);
    const { dir, cleanup } = tempDir();
    cleanups.push(cleanup);
    const seen: number[] = [];
    const started = Date.now();
    await Effect.runPromise(
      Downloads.use((downloads) =>
        downloads.file(`${base}/file`, path.join(dir, "file"), (received) =>
          Effect.sync(() => void seen.push(received)),
        ),
      ).pipe(Effect.provide(downloadsLayer({ hosts: ["127.0.0.1"], allowHttp: true }))),
    );
    // Hundreds of chunks arrive; about one report per 100 ms goes out, and the last says it all arrived.
    expect(seen.length).toBeLessThanOrEqual(Math.ceil((Date.now() - started) / 100) + 2);
    expect(seen.at(-1)).toBe(bytes.byteLength);
  });

  it("fails instead of hanging when the file can't be written", async () => {
    const base = await server(Buffer.alloc(300_000, 7));
    const { dir, cleanup } = tempDir();
    cleanups.push(cleanup);
    // A file where a folder should be: the download can't be created there.
    fs.writeFileSync(path.join(dir, "taken"), "");
    const error = await Effect.runPromise(
      Effect.flip(
        Downloads.use((downloads) =>
          downloads.file(`${base}/file`, path.join(dir, "taken", "file"), () => Effect.void),
        ).pipe(Effect.provide(downloadsLayer({ hosts: ["127.0.0.1"], allowHttp: true }))),
      ),
    );
    expect(error._tag).toBe("DownloadFailed");
    expect(error.message).toMatch(/ENOTDIR/);
  });

  it("keeps to one download's own hosts and size, also when the server doesn't say the size", async () => {
    const base = await server(Buffer.alloc(300_000, 7));
    const { dir, cleanup } = tempDir();
    cleanups.push(cleanup);
    const layer = downloadsLayer({ hosts: ["127.0.0.1", "localhost"], allowHttp: true });
    const fetchFile = (route: string, limits: DownloadLimits) =>
      Effect.runPromise(
        Effect.flip(
          Downloads.use((d) => d.file(`${base}${route}`, path.join(dir, "file"), () => Effect.void, limits)).pipe(
            Effect.provide(layer),
          ),
        ),
      );
    expect((await fetchFile("/localhost", { hosts: ["127.0.0.1"] })).message).toBe(
      "Downloads from localhost aren't allowed.",
    );
    expect((await fetchFile("/file", { maxBytes: 1000 })).message).toBe("The file is larger than expected.");
    expect((await fetchFile("/stream", { maxBytes: 1000 })).message).toBe("The file is larger than expected.");
  });

  it("refuses plain HTTP and hosts outside the list, including after a redirect", async () => {
    const base = await server(Buffer.from("x"));
    const layer = downloadsLayer({ hosts: ["127.0.0.1"], allowHttp: true });
    const away = await Effect.runPromise(
      Effect.flip(Downloads.use((d) => d.text(`${base}/away`)).pipe(Effect.provide(layer))),
    );
    expect(away.message).toBe("Downloads from example.com aren't allowed.");
    const insecure = await Effect.runPromise(
      Effect.flip(
        Downloads.use((d) => d.text(`${base}/file`)).pipe(Effect.provide(downloadsLayer({ hosts: ["127.0.0.1"] }))),
      ),
    );
    expect(insecure.message).toBe("Downloads from 127.0.0.1 aren't allowed.");
  });
});

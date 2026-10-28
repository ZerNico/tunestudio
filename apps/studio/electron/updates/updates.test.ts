import { createHash, generateKeyPairSync, type KeyObject, sign } from "node:crypto";
import fs from "node:fs";
import path from "node:path";

import { NodeServices } from "@effect/platform-node";
import { afterEach, describe, expect, it } from "@effect/vitest";
import { Effect, Layer } from "effect";

import type { Progress } from "../../src/lib/native/types";
import { AppLog } from "../services/app-log";
import { tempDir } from "../testing";
import { DownloadFailed, Downloads } from "../tools/downloads";
import type { Installation } from "./install";
import { assetName, isNewer, updateTarget, verifySignature } from "./manifest";
import { Updates, updatesLayer } from "./updates";

let cleanups: (() => void)[] = [];
afterEach(() => {
  for (const cleanup of cleanups.toReversed()) cleanup();
  cleanups = [];
});

function keyPair() {
  const { privateKey, publicKey } = generateKeyPairSync("ed25519");
  return { privateKey, publicKey: publicKey.export({ type: "spki", format: "der" }).subarray(-32).toString("base64") };
}
const signed = (text: string, key: KeyObject) => sign(null, Buffer.from(text), key).toString("base64");
const sha256 = (bytes: Buffer) => createHash("sha256").update(bytes).digest("hex");

const INSTALLER = Buffer.from("the new version's AppImage");
const RELEASES = "https://github.com/ZerNico/tunestudio/releases";

function manifest(version: string, file: Partial<{ size: number; sha256: string }> = {}) {
  return `${JSON.stringify({
    version,
    files: {
      "linux-x64": {
        name: `Tune.Studio_${version}_x64.AppImage`,
        size: INSTALLER.length,
        sha256: sha256(INSTALLER),
        ...file,
      },
    },
  })}\n`;
}

/**
 * The updates service against a fake GitHub whose latest release is `tag` (the manifest's version by default), with
 * `manifest` and its signature by `key`.
 */
function setup(options: {
  manifest: string | null;
  tag?: string;
  signature?: string;
  key?: KeyObject;
  installation?: Installation;
  publicKey?: string;
}) {
  const { dir, cleanup } = tempDir();
  cleanups.push(cleanup);
  const keys = keyPair();
  const requested: string[] = [];
  const quits: number[] = [];
  const signature =
    options.signature ?? (options.manifest ? signed(options.manifest, options.key ?? keys.privateKey) : "");
  const offline = (url: string) => new DownloadFailed({ url, message: "No connection." });
  const downloads = Layer.succeed(Downloads, {
    json: (url) => Effect.fail(offline(url)),
    redirect: (url) =>
      Effect.suspend(() => {
        requested.push(url);
        if (options.manifest === null || url !== `${RELEASES}/latest`) return Effect.fail(offline(url));
        const tag = options.tag ?? `v${(JSON.parse(options.manifest) as { version: string }).version}`;
        return Effect.succeed(`${RELEASES}/tag/${tag}`);
      }),
    text: (url) =>
      Effect.suspend(() => {
        requested.push(url);
        const tag = options.tag ?? `v${(JSON.parse(options.manifest!) as { version: string }).version}`;
        if (url === `${RELEASES}/download/${tag}/latest.json`) return Effect.succeed(options.manifest!);
        if (url === `${RELEASES}/download/${tag}/latest.json.sig`) return Effect.succeed(signature);
        return Effect.fail(offline(url));
      }),
    file: (url, file, onBytes, limits) =>
      Effect.gen(function* () {
        requested.push(url);
        expect(limits?.maxBytes).toBe(INSTALLER.length);
        fs.writeFileSync(file, INSTALLER);
        yield* onBytes(INSTALLER.length, INSTALLER.length);
        return { sha256: sha256(INSTALLER), size: INSTALLER.length };
      }),
  });
  const installed = path.join(dir, "Tune Studio.AppImage");
  const layer = updatesLayer({
    folder: path.join(dir, "updates"),
    version: "0.2.0",
    target: "linux-x64",
    installation: options.installation ?? { kind: "appimage", file: installed },
    publicKey: options.publicKey ?? keys.publicKey,
    quit: () => void quits.push(Date.now()),
  }).pipe(
    Layer.provide(Layer.mergeAll(downloads, Layer.succeed(AppLog, { write: () => Effect.void }), NodeServices.layer)),
  );
  return { dir, layer, requested, quits, keys };
}

describe("the update feed", () => {
  it("takes the release key's signature only", () => {
    const { privateKey, publicKey } = keyPair();
    const other = keyPair();
    const text = Buffer.from(manifest("0.3.0"));
    const signature = sign(null, text, privateKey).toString("base64");
    expect(verifySignature(text, signature, publicKey)).toBe(true);
    expect(verifySignature(text, `${signature}\n`, publicKey)).toBe(true);
    expect(verifySignature(text, signature, other.publicKey)).toBe(false);
    expect(verifySignature(Buffer.from(manifest("9.9.9")), signature, publicKey)).toBe(false);
    expect(verifySignature(text, "bm90IGEgc2lnbmF0dXJl", publicKey)).toBe(false);
    expect(verifySignature(text, signature, "")).toBe(false);
  });

  it("compares versions by number", () => {
    expect(isNewer("0.2.1", "0.2.0")).toBe(true);
    expect(isNewer("0.10.0", "0.9.9")).toBe(true);
    expect(isNewer("v1.0.0", "0.99.0")).toBe(true);
    expect(isNewer("0.2.0", "0.2.0")).toBe(false);
    expect(isNewer("0.1.9", "0.2.0")).toBe(false);
    expect(isNewer("0.3.0-beta", "0.2.0")).toBe(false);
  });

  it("knows the update files by name, as GitHub stores them", () => {
    expect(updateTarget("Tune Studio_0.2.0_arm64.app.tar.gz")).toBe("darwin-arm64");
    expect(updateTarget("Tune Studio_0.2.0_x64-setup.exe")).toBe("win32-x64");
    expect(updateTarget("Tune Studio_0.2.0_x64.AppImage")).toBe("linux-x64");
    expect(updateTarget("Tune Studio_0.2.0_arm64.dmg")).toBeNull();
    expect(assetName("Tune Studio_0.2.0_arm64.dmg")).toBe("Tune.Studio_0.2.0_arm64.dmg");
  });
});

describe("Updates", () => {
  it.effect("offers a newer signed release once, downloads it and restarts to install it", () => {
    const { layer, requested, quits, dir } = setup({ manifest: manifest("0.3.0") });
    return Effect.gen(function* () {
      const updates = yield* Updates;
      const update = {
        version: "0.3.0",
        page: "https://github.com/ZerNico/tunestudio/releases/tag/v0.3.0",
        installable: true,
      };
      expect(yield* updates.announce).toEqual(update);
      // Another window: already told.
      expect(yield* updates.announce).toBeNull();
      expect(requested).toEqual([
        `${RELEASES}/latest`,
        `${RELEASES}/download/v0.3.0/latest.json`,
        `${RELEASES}/download/v0.3.0/latest.json.sig`,
      ]);

      yield* Effect.flip(updates.restart);
      const progress: Progress[] = [];
      yield* updates.download((event) => Effect.sync(() => void progress.push(event)));
      expect(progress.at(-1)).toEqual({ step: "Downloading the update", done: 26, total: 26, unit: "bytes" });
      expect(requested.at(-1)).toBe(
        "https://github.com/ZerNico/tunestudio/releases/download/v0.3.0/Tune.Studio_0.3.0_x64.AppImage",
      );
      // Downloaded, but only a restart installs it: quitting the usual way doesn't.
      expect(yield* updates.staged).toBeNull();
      yield* updates.restart;
      expect(quits).toHaveLength(1);
      const staged = yield* updates.staged;
      expect(staged).toEqual({
        kind: "appimage",
        file: path.join(dir, "Tune Studio.AppImage"),
        source: path.join(dir, "updates", "0.3.0", "Tune.Studio_0.3.0_x64.AppImage"),
      });
      // Downloading again keeps the one there.
      yield* updates.download(() => Effect.void);
      expect(requested).toHaveLength(4);
    }).pipe(Effect.provide(layer));
  });

  it.effect("has nothing for the version it is, or an older one", () => {
    const { layer } = setup({ manifest: manifest("0.2.0") });
    return Effect.gen(function* () {
      const updates = yield* Updates;
      expect(yield* updates.check({ force: true })).toBeNull();
      expect(yield* updates.announce).toBeNull();
      expect(yield* updates.staged).toBeNull();
    }).pipe(Effect.provide(layer));
  });

  it.effect("refuses a feed signed by another key, saying so only when asked", () => {
    const other = keyPair();
    const { layer } = setup({ manifest: manifest("0.3.0"), key: other.privateKey });
    return Effect.gen(function* () {
      const updates = yield* Updates;
      expect(yield* updates.announce).toBeNull();
      const error = yield* Effect.flip(updates.check({ force: true }));
      expect(error.message).toBe("The update's signature isn't valid.");
    }).pipe(Effect.provide(layer));
  });

  it.effect("refuses a feed that isn't its release's", () => {
    const { layer } = setup({ manifest: manifest("0.3.0"), tag: "v0.4.0" });
    return Effect.gen(function* () {
      const error = yield* Effect.flip(Updates.use((updates) => updates.check({ force: true })));
      expect(error.message).toBe("The update doesn't match its release.");
    }).pipe(Effect.provide(layer));
  });

  it.effect("stays quiet offline at start, and says so when asked", () => {
    const { layer } = setup({ manifest: null });
    return Effect.gen(function* () {
      const updates = yield* Updates;
      expect(yield* updates.announce).toBeNull();
      const error = yield* Effect.flip(updates.check({ force: true }));
      expect(error.message).toMatch(/couldn't check for updates/);
    }).pipe(Effect.provide(layer));
  });

  it.effect("never asks without the release key", () => {
    const { layer, requested } = setup({ manifest: manifest("0.3.0"), publicKey: "" });
    return Effect.gen(function* () {
      expect(yield* Updates.use((updates) => updates.check({ force: true }))).toBeNull();
      expect(requested).toEqual([]);
    }).pipe(Effect.provide(layer));
  });

  it.effect("refuses a download that isn't the file the feed names", () => {
    const { layer } = setup({ manifest: manifest("0.3.0", { sha256: "0".repeat(64) }) });
    return Effect.gen(function* () {
      const updates = yield* Updates;
      yield* updates.check({ force: false });
      const error = yield* Effect.flip(updates.download(() => Effect.void));
      expect(error.message).toBe("The update didn't download correctly. Try again.");
      expect(yield* updates.staged).toBeNull();
    }).pipe(Effect.provide(layer));
  });

  it.effect("sends a copy that can't replace itself to the release page", () => {
    const { layer } = setup({ manifest: manifest("0.3.0"), installation: { kind: "manual" } });
    return Effect.gen(function* () {
      const updates = yield* Updates;
      expect((yield* updates.announce)?.installable).toBe(false);
      yield* Effect.flip(updates.download(() => Effect.void));
    }).pipe(Effect.provide(layer));
  });
});

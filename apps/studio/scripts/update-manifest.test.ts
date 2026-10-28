import { execFileSync } from "node:child_process";
import { createHash, generateKeyPairSync } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { afterEach, describe, expect, it } from "vitest";

import { verifySignature } from "../electron/updates/manifest.ts";

const script = fileURLToPath(new URL("./update-manifest.ts", import.meta.url));
let folders: string[] = [];
afterEach(() => {
  for (const folder of folders) fs.rmSync(folder, { recursive: true, force: true });
  folders = [];
});

/** A release job's artifacts folder: each build's files in a folder of their own. */
function artifacts(files: Record<string, string>) {
  const folder = fs.mkdtempSync(path.join(os.tmpdir(), "tunestudio-release-"));
  folders.push(folder);
  for (const [name, content] of Object.entries(files)) {
    fs.mkdirSync(path.join(folder, path.dirname(name)), { recursive: true });
    fs.writeFileSync(path.join(folder, name), content);
  }
  return folder;
}

const RELEASE = {
  "tunestudio-macos-arm64/Tune Studio_0.3.0_arm64.dmg": "dmg",
  "tunestudio-macos-arm64/Tune Studio_0.3.0_arm64.app.tar.gz": "app",
  "tunestudio-windows-x64/Tune Studio_0.3.0_x64-setup.exe": "exe",
  "tunestudio-linux-x64/Tune Studio_0.3.0_x64.AppImage": "appimage",
};

function run(folder: string, version: string) {
  const { privateKey, publicKey } = generateKeyPairSync("ed25519");
  execFileSync("bun", [script, folder, version], {
    env: { ...process.env, TUNESTUDIO_UPDATE_KEY: privateKey.export({ type: "pkcs8", format: "pem" }).toString() },
    stdio: "pipe",
  });
  return publicKey.export({ type: "spki", format: "der" }).subarray(-32).toString("base64");
}

describe("update-manifest", () => {
  it("signs a feed naming each system's update file as GitHub stores it", () => {
    const folder = artifacts(RELEASE);
    const publicKey = run(folder, "v0.3.0");
    const text = fs.readFileSync(path.join(folder, "latest.json"));
    expect(verifySignature(text, fs.readFileSync(path.join(folder, "latest.json.sig"), "utf8"), publicKey)).toBe(true);
    const sha256 = (content: string) => createHash("sha256").update(content).digest("hex");
    expect(JSON.parse(text.toString())).toEqual({
      version: "0.3.0",
      files: {
        "darwin-arm64": { name: "Tune.Studio_0.3.0_arm64.app.tar.gz", size: 3, sha256: sha256("app") },
        "win32-x64": { name: "Tune.Studio_0.3.0_x64-setup.exe", size: 3, sha256: sha256("exe") },
        "linux-x64": { name: "Tune.Studio_0.3.0_x64.AppImage", size: 8, sha256: sha256("appimage") },
      },
    });
  });

  it("fails when a system has no update file, or one of another version", () => {
    const { "tunestudio-windows-x64/Tune Studio_0.3.0_x64-setup.exe": _, ...withoutWindows } = RELEASE;
    expect(() => run(artifacts(withoutWindows), "v0.3.0")).toThrow(/No update file for win32-x64/);
    expect(() => run(artifacts(RELEASE), "v0.3.1")).toThrow(/isn't version 0.3.1/);
  });
});

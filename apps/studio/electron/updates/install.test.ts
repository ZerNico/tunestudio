import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { APP_ID } from "../identity";
import { infoPlist, tempDir } from "../testing";
import { apply, installation, prepare } from "./install";

let cleanups: (() => void)[] = [];
afterEach(() => {
  for (const cleanup of cleanups.toReversed()) cleanup();
  cleanups = [];
});

function folder() {
  const { dir, cleanup } = tempDir();
  cleanups.push(cleanup);
  return dir;
}

/** A Tune Studio bundle in `parent` whose program prints `version`. */
function bundle(parent: string, version: string, identifier = APP_ID) {
  const app = path.join(parent, "Tune Studio.app");
  fs.mkdirSync(path.join(app, "Contents", "MacOS"), { recursive: true });
  fs.writeFileSync(path.join(app, "Contents", "Info.plist"), infoPlist("Tune Studio", identifier));
  fs.writeFileSync(path.join(app, "Contents", "MacOS", "Tune Studio"), `#!/bin/sh\necho ${version}\n`, { mode: 0o755 });
  return app;
}

describe("installation", () => {
  it("updates a macOS bundle in place, unless it runs from the disk image or a translocated copy", () => {
    const execPath = (bundlePath: string) => `${bundlePath}/Contents/MacOS/Tune Studio`;
    const where = (execPathOf: string) => installation({ platform: "darwin", execPath: execPathOf, env: {} });
    expect(where(execPath("/Applications/Tune Studio.app"))).toEqual({
      kind: "macos",
      bundle: "/Applications/Tune Studio.app",
    });
    expect(where(execPath("/Volumes/Tune Studio/Tune Studio.app")).kind).toBe("manual");
    expect(where(execPath("/private/var/folders/x/AppTranslocation/1234/d/Tune Studio.app")).kind).toBe("manual");
  });

  it("updates an AppImage, not a folder of files", () => {
    expect(
      installation({ platform: "linux", execPath: "/opt/x/tunestudio", env: { APPIMAGE: "/home/a/T.AppImage" } }),
    ).toEqual({ kind: "appimage", file: "/home/a/T.AppImage" });
    expect(installation({ platform: "linux", execPath: "/opt/x/tunestudio", env: {} }).kind).toBe("manual");
  });

  it("updates a copy the Windows installer put there", () => {
    const dir = folder();
    const execPath = path.join(dir, "Tune Studio.exe");
    expect(installation({ platform: "win32", execPath, env: {} }).kind).toBe("manual");
    fs.writeFileSync(path.join(dir, "Uninstall Tune Studio.exe"), "");
    expect(installation({ platform: "win32", execPath, env: {} }).kind).toBe("windows");
  });
});

describe.skipIf(process.platform !== "darwin")("installing on macOS", () => {
  /** The new version's archive, as `package.ts` makes it. */
  function archive(dir: string, version: string, identifier?: string) {
    const packed = path.join(dir, "packed");
    bundle(packed, version, identifier);
    const file = path.join(dir, `Tune Studio_${version}_arm64.app.tar.gz`);
    execFileSync("tar", ["-czf", file, "-C", packed, "Tune Studio.app"]);
    return file;
  }

  it("swaps the bundle and opens it again once the app has exited", async () => {
    const dir = folder();
    const applications = path.join(dir, "Applications");
    const installed = bundle(applications, "0.2.0");
    const work = path.join(dir, "work");
    fs.mkdirSync(work);
    const staged = await prepare({ kind: "macos", bundle: installed }, archive(dir, "0.3.0"), work);

    const later: string[] = [];
    apply(staged, (error) => expect.unreachable(error.message), { afterExit: (script) => void later.push(script) });
    expect(execFileSync(path.join(installed, "Contents", "MacOS", "Tune Studio"), { encoding: "utf8" })).toBe(
      "0.3.0\n",
    );
    // The old version stays beside it until the app has exited, then it goes and the bundle opens again.
    const beside = fs.readdirSync(applications).toSorted();
    expect(beside).toEqual([expect.stringMatching(/^\.Tune Studio\.previous-\d+-\d+\.app$/), "Tune Studio.app"]);
    expect(later).toHaveLength(1);
    execFileSync("/bin/sh", ["-c", later[0]!.replace(/; \/usr\/bin\/open .*$/, "")]);
    expect(later[0]).toContain(`/usr/bin/open '${installed}'`);
    expect(fs.readdirSync(applications)).toEqual(["Tune Studio.app"]);
  });

  it("refuses an archive that isn't Tune Studio", async () => {
    const dir = folder();
    const installed = bundle(path.join(dir, "Applications"), "0.2.0");
    const work = path.join(dir, "work");
    fs.mkdirSync(work);
    await expect(
      prepare({ kind: "macos", bundle: installed }, archive(dir, "0.3.0", "org.example.other"), work),
    ).rejects.toThrow("The update isn't Tune Studio");
  });
});

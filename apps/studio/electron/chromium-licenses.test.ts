import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { CHROMIUM_LICENSES, chromiumLicensesFile } from "./chromium-licenses";

describe("chromiumLicensesFile", () => {
  let dir: string;
  afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

  const touch = (file: string) => {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, "");
    return file;
  };

  it("finds the file in a packaged macOS app's resources", () => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "chromium-"));
    const contents = path.join(dir, "Tune Studio.app/Contents");
    const file = touch(path.join(contents, "Resources", CHROMIUM_LICENSES));
    expect(
      chromiumLicensesFile({
        execPath: path.join(contents, "MacOS/Tune Studio"),
        resourcesPath: path.join(contents, "Resources"),
      }),
    ).toBe(file);
  });

  it("finds the file next to the executable on Windows and Linux", () => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "chromium-"));
    const file = touch(path.join(dir, CHROMIUM_LICENSES));
    expect(
      chromiumLicensesFile({ execPath: path.join(dir, "tunestudio"), resourcesPath: path.join(dir, "resources") }),
    ).toBe(file);
  });

  it("finds the file beside Electron.app when running unpackaged, and null without it", () => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "chromium-"));
    const contents = path.join(dir, "Electron.app/Contents");
    const paths = { execPath: path.join(contents, "MacOS/Electron"), resourcesPath: path.join(contents, "Resources") };
    expect(chromiumLicensesFile(paths)).toBeNull();
    const file = touch(path.join(dir, CHROMIUM_LICENSES));
    expect(chromiumLicensesFile(paths)).toBe(file);
  });
});

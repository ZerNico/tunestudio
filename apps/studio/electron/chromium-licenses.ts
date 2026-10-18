import fs from "node:fs";
import path from "node:path";

/** The notices of Chromium and its libraries, which Electron ships beside its binary. */
export const CHROMIUM_LICENSES = "LICENSES.chromium.html";

/**
 * Where Chromium's licenses are: the app's resources on macOS once packaged (electron-builder moves them into the
 * bundle), next to the executable on Windows and Linux, and in Electron's own folder (beside `Electron.app`) when
 * running unpackaged on macOS. Null when none of them has the file.
 */
export function chromiumLicensesFile(paths: { execPath: string; resourcesPath: string }): string | null {
  const candidates = [
    path.join(paths.resourcesPath, CHROMIUM_LICENSES),
    path.join(path.dirname(paths.execPath), CHROMIUM_LICENSES),
    path.resolve(path.dirname(paths.execPath), "../../..", CHROMIUM_LICENSES),
  ];
  return candidates.find((file) => fs.existsSync(file)) ?? null;
}

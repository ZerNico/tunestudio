/**
 * Putting a downloaded update in place of the running app, without Apple's or Microsoft's code signing: macOS swaps
 * the .app bundle (a file Tune Studio downloaded itself has no quarantine flag, so Gatekeeper doesn't ask again),
 * Windows runs the new installer silently, Linux replaces the AppImage. `prepare` checks the download while the app
 * runs, so a bad file fails in the update's toast; `apply` runs while quitting, once every page has saved and the
 * services are closed. Plain Node, synchronous in `apply`: by then the Effect runtime is gone.
 */
import { execFile, execFileSync, spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { promisify } from "node:util";

import { APP_ID } from "../identity";

const run = promisify(execFile);

/** How this copy was installed, which decides whether and how it can replace itself. */
export type Installation =
  | { readonly kind: "macos"; readonly bundle: string }
  | { readonly kind: "windows" }
  | { readonly kind: "appimage"; readonly file: string }
  /** Not updatable in place: run from the dmg, moved by macOS to a random folder, or a folder of files. */
  | { readonly kind: "manual" };

export function installation(options: {
  platform: NodeJS.Platform;
  execPath: string;
  env: Record<string, string | undefined>;
}): Installation {
  if (options.platform === "darwin") {
    // …/Tune Studio.app/Contents/MacOS/Tune Studio
    const bundle = path.resolve(options.execPath, "../../..");
    // Opened from the disk image, or from Downloads without moving it first: macOS runs that copy from a read-only
    // random folder ("App Translocation"), so replacing it would change nothing.
    if (!bundle.endsWith(".app") || bundle.startsWith("/Volumes/") || bundle.includes("/AppTranslocation/"))
      return { kind: "manual" };
    return { kind: "macos", bundle };
  }
  if (options.platform === "win32") {
    // The installer's uninstaller sits next to the program; without it this isn't an installed copy.
    const uninstaller = fs
      .readdirSync(path.dirname(options.execPath), { withFileTypes: true })
      .some((entry) => entry.isFile() && /^Uninstall .*\.exe$/i.test(entry.name));
    return uninstaller ? { kind: "windows" } : { kind: "manual" };
  }
  const appImage = options.env.APPIMAGE;
  return appImage ? { kind: "appimage", file: appImage } : { kind: "manual" };
}

/** A downloaded update, checked and ready for `apply`. */
export type Staged =
  | { readonly kind: "macos"; readonly bundle: string; readonly source: string }
  | { readonly kind: "windows"; readonly installer: string }
  | { readonly kind: "appimage"; readonly file: string; readonly source: string };

/**
 * Makes the downloaded `file` ready to install into `target` (`work` is an empty folder of its own): unpacks the
 * macOS archive (without holding up the windows) and checks it holds Tune Studio. Rejects when it can't.
 */
export async function prepare(
  target: Exclude<Installation, { kind: "manual" }>,
  file: string,
  work: string,
): Promise<Staged> {
  switch (target.kind) {
    case "macos": {
      const extracted = path.join(work, "extracted");
      await fs.promises.mkdir(extracted);
      await run("/usr/bin/tar", ["-xzf", file, "-C", extracted]);
      const bundles = (await fs.promises.readdir(extracted)).filter((name) => name.endsWith(".app"));
      if (bundles.length !== 1) throw new Error("The update holds no app");
      const source = path.join(extracted, bundles[0]!);
      const plist = path.join(source, "Contents", "Info.plist");
      const { stdout } = await run("/usr/bin/plutil", ["-extract", "CFBundleIdentifier", "raw", "-o", "-", plist]);
      if (stdout.trim() !== APP_ID) throw new Error("The update isn't Tune Studio");
      return { kind: "macos", bundle: target.bundle, source };
    }
    case "windows":
      return { kind: "windows", installer: file };
    case "appimage":
      await fs.promises.chmod(file, 0o755);
      return { kind: "appimage", file: target.file, source: file };
  }
}

const quote = (value: string) => `'${value.replaceAll("'", "'\\''")}'`;

/**
 * Runs `script` (sh) once this process has exited, detached from it: what starts the app again, and what removes the
 * files the running app still uses.
 */
function afterExit(script: string) {
  const wait = `while kill -0 ${process.pid} 2>/dev/null; do sleep 0.2; done`;
  spawn("/bin/sh", ["-c", `${wait}; ${script}`], { detached: true, stdio: "ignore" }).unref();
}

/**
 * Replaces the bundle: the new one is copied next to it, then the two are swapped by renaming, so the app is never
 * missing for long, and the old one is put back if the swap fails. The old one is removed once this process has
 * exited, then the bundle opens again (the new version, or the old one when the swap failed). A folder the user
 * can't write to (an `/Applications` owned by another account) asks for an administrator's password the way macOS
 * installers do.
 */
function swapBundle(bundle: string, source: string, later: (script: string) => void) {
  const folder = path.dirname(bundle);
  const name = path.basename(bundle, ".app");
  // Names of this swap's own, so what an earlier one left (another account's files, say) never stands in the way.
  const stamp = `${process.pid}-${Date.now()}`;
  const incoming = path.join(folder, `.${name}.update-${stamp}.app`);
  const outgoing = path.join(folder, `.${name}.previous-${stamp}.app`);
  const swap = [
    `/usr/bin/ditto ${quote(source)} ${quote(incoming)}`,
    `mv ${quote(bundle)} ${quote(outgoing)}`,
    `{ mv ${quote(incoming)} ${quote(bundle)} || { mv ${quote(outgoing)} ${quote(bundle)}; exit 1; }; }`,
  ].join(" && ");
  // The old bundle goes once this process has exited, and only when the app is back in its place.
  const wait = `while kill -0 ${process.pid} 2>/dev/null; do sleep 0.2; done`;
  const cleanUp = `rm -rf ${quote(incoming)}; [ -d ${quote(bundle)} ] && rm -rf ${quote(outgoing)}`;
  let writable = true;
  try {
    fs.accessSync(folder, fs.constants.W_OK);
    fs.accessSync(bundle, fs.constants.W_OK);
  } catch {
    writable = false;
  }
  try {
    if (writable) execFileSync("/bin/sh", ["-c", swap]);
    else {
      // As the administrator, who can remove the old bundle too: a background job, its output closed so the
      // script returns.
      const script = `${swap} && { (${wait}; ${cleanUp}) >/dev/null 2>&1 & }`;
      execFileSync("/usr/bin/osascript", [
        "-e",
        `do shell script ${JSON.stringify(script)} with administrator privileges`,
      ]);
    }
  } finally {
    later(`${writable ? `${cleanUp}; ` : ""}/usr/bin/open ${quote(bundle)}`);
  }
}

/** Starts `file` (an AppImage) once this process has exited, with the descriptors it inherited closed first. */
function relaunchAppImage(file: string, args: readonly string[]) {
  // bash: `exec {n}>&-` closes descriptors above 9, which dash can't. Chromium leaves sockets and files of the old
  // AppImage's mount open across exec, which would keep that mount alive.
  const script = [
    'for fd in /proc/$$/fd/*; do n=${fd##*/}; [ "$n" -gt 2 ] && exec {n}>&-; done 2>/dev/null',
    'while kill -0 "$0" 2>/dev/null; do sleep 0.2; done',
    'exec "$@"',
  ].join("; ");
  spawn("/bin/bash", ["-c", script, String(process.pid), file, ...args], { detached: true, stdio: "ignore" }).unref();
}

/**
 * Installs `staged`, and starts the new version once this process has exited. Throws when the old version stays
 * (the user refused the password, say), after arranging for that one to start again. On Windows the installer may
 * fail to start a moment later: `onFailed` then starts this version again (Electron's relaunch, before it exits).
 */
export function apply(
  staged: Staged,
  onFailed: (error: Error) => void,
  options: {
    /** The arguments the new version starts with. */
    args?: readonly string[];
    /** Runs a shell script once this process has exited (tests look at it instead). */
    afterExit?: (script: string) => void;
  } = {},
) {
  const args = options.args ?? process.argv.slice(1);
  switch (staged.kind) {
    case "macos":
      swapBundle(staged.bundle, staged.source, options.afterExit ?? afterExit);
      return;
    case "windows":
      // electron-builder's installer, silent, as an update (shortcuts kept), starting the app when done. It waits for
      // this process to exit.
      fs.accessSync(staged.installer, fs.constants.R_OK);
      spawn(staged.installer, ["/S", "--updated", "--force-run"], { detached: true, stdio: "ignore" })
        .on("error", onFailed)
        .unref();
      return;
    case "appimage": {
      // Copied next to the AppImage first, so the rename that replaces it is atomic.
      const temp = `${staged.file}.update`;
      try {
        fs.copyFileSync(staged.source, temp);
        fs.chmodSync(temp, 0o755);
        fs.renameSync(temp, staged.file);
      } finally {
        relaunchAppImage(staged.file, args);
      }
      return;
    }
  }
}

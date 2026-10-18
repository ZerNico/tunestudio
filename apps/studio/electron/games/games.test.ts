import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

import { NodeServices } from "@effect/platform-node";
import { afterEach, describe, expect, it } from "@effect/vitest";
import { Effect } from "effect";

import { fakeGameApp, infoPlist, tempDir } from "../testing";
import { cleanEnv, findGame, launchArgs, programOf } from "./games";
import { gameLauncherLayer, GameLauncher } from "./launcher";
import { plistStrings, readInfoPlist } from "./plist";

let cleanups: (() => void)[] = [];
afterEach(() => {
  for (const cleanup of cleanups.toReversed()) cleanup();
  cleanups = [];
});

function temp() {
  const made = tempDir();
  cleanups.push(made.cleanup);
  return made.dir;
}

const run = <A, E>(effect: Effect.Effect<A, E, NodeServices.NodeServices>) =>
  Effect.runPromise(effect.pipe(Effect.provide(NodeServices.layer)));

/** Why `programOf` refused, or the program. */
const program = (app: string, os: NodeJS.Platform = "darwin") =>
  run(programOf(app, os).pipe(Effect.catchTag("GameUnusable", (error) => Effect.succeed(`refused: ${error.message}`))));

const SCRIPT = "#!/bin/sh\nexit 0\n";

describe("launchArgs", () => {
  it("passes the song folder with each game's own option", () => {
    const folder = "/data/try-in-game/Artist - Title";
    expect(launchArgs("tune-perfect", folder)).toEqual(["--songpath", folder]);
    expect(launchArgs("usdx", folder)).toEqual(["-songpath", folder]);
    expect(launchArgs("vocaluxe", folder)).toEqual(["-SongFolder", folder]);
    // No empty option before it, as USDB Syncer would pass.
    expect(launchArgs("performous", folder)).toEqual([folder]);
  });
});

describe("cleanEnv", () => {
  it("drops what Electron, Node, the app bundle and an AppImage set for themselves", () => {
    expect(
      cleanEnv({
        PATH: "/usr/bin",
        HOME: "/Users/someone",
        LANG: "de_DE.UTF-8",
        ELECTRON_RUN_AS_NODE: "1",
        ELECTRON_NO_ATTACH_CONSOLE: "1",
        NODE_OPTIONS: "--inspect",
        TUNESTUDIO_BACKGROUND: "1",
        __CFBundleIdentifier: "org.tuneperfect.studio",
        CHROME_DESKTOP: "tunestudio.desktop",
        APPIMAGE: "/home/someone/Tune Studio.AppImage",
        APPDIR: "/tmp/.mount_x",
        UNSET: undefined,
      }),
    ).toEqual({ PATH: "/usr/bin", HOME: "/Users/someone", LANG: "de_DE.UTF-8" });
  });
});

describe("Info.plist", () => {
  it("reads the top-level strings, not a nested dictionary's", () => {
    const strings = plistStrings(infoPlist("tuneperfect", "org.tuneperfect.game"));
    expect(strings.get("CFBundleExecutable")).toBe("tuneperfect");
    expect(strings.get("CFBundleIdentifier")).toBe("org.tuneperfect.game");
    expect(strings.get("CFBundleDisplayName")).toBe("Game & Friends");
    expect(strings.get("NSEmptyValue")).toBe("");
    expect(strings.has("LSRequiresNativeExecution")).toBe(false);
  });

  it.runIf(process.platform === "darwin")("reads a binary one through plutil", async () => {
    const app = fakeGameApp(temp(), "Binary", "game", SCRIPT);
    execFileSync("plutil", ["-convert", "binary1", path.join(app, "Contents", "Info.plist")]);
    expect(
      fs
        .readFileSync(path.join(app, "Contents", "Info.plist"))
        .subarray(0, 8)
        .toString(),
    ).toBe("bplist00");
    const strings = await run(readInfoPlist(app));
    expect(strings?.get("CFBundleExecutable")).toBe("game");
  });

  it("is null for a bundle without one", async () => {
    const dir = temp();
    expect(await run(readInfoPlist(dir))).toBeNull();
  });
});

describe("programOf", () => {
  it("is the program a bundle's Info.plist names", async () => {
    const app = fakeGameApp(temp(), "Tune Perfect", "tuneperfect", SCRIPT);
    expect(await program(app)).toBe(path.join(app, "Contents", "MacOS", "tuneperfect"));
  });

  it("refuses what can't be started, saying why", async () => {
    const dir = temp();
    expect(await program(path.join(dir, "Gone.app"))).toBe("refused: “Gone.app” doesn't exist anymore.");

    const noPlist = path.join(dir, "Empty.app");
    fs.mkdirSync(noPlist);
    expect(await program(noPlist)).toBe("refused: “Empty.app” doesn't say which program to start.");

    // A program name that would climb out of Contents/MacOS.
    const escaping = fakeGameApp(dir, "Escape", "game", SCRIPT);
    fs.writeFileSync(path.join(escaping, "Contents", "Info.plist"), infoPlist("../../../../bin/sh"));
    expect(await program(escaping)).toBe("refused: “Escape.app” doesn't say which program to start.");

    const missing = fakeGameApp(dir, "Missing", "game", SCRIPT);
    fs.rmSync(path.join(missing, "Contents", "MacOS", "game"));
    expect(await program(missing)).toBe("refused: “Missing.app” is missing its program.");

    const notRunnable = fakeGameApp(dir, "Plain", "game", SCRIPT);
    fs.chmodSync(path.join(notRunnable, "Contents", "MacOS", "game"), 0o644);
    expect(await program(notRunnable)).toBe("refused: “Plain.app” is missing its program.");

    const file = path.join(dir, "notes.txt");
    fs.writeFileSync(file, "x");
    expect(await program(file)).toBe("refused: “notes.txt” isn't a program.");
    expect(await program(dir, "linux")).toBe(`refused: “${path.basename(dir)}” isn't a program.`);
  });

  it("takes a program as it is outside macOS", async () => {
    const dir = temp();
    const game = path.join(dir, "ultrastardx");
    fs.writeFileSync(game, SCRIPT, { mode: 0o755 });
    expect(await program(game, "linux")).toBe(game);
    // Windows goes by the extension.
    expect(await program(game, "win32")).toBe("refused: “ultrastardx” isn't a program.");
    const exe = path.join(dir, "ultrastardx.exe");
    fs.writeFileSync(exe, "MZ");
    expect(await program(exe, "win32")).toBe(exe);
  });
});

describe("findGame", () => {
  it("finds a macOS app by its name, also renamed, and skips ones that can't start", async () => {
    const dir = temp();
    const applications = path.join(dir, "Applications");
    const user = path.join(dir, "home", "Applications");
    fs.mkdirSync(applications);
    fs.mkdirSync(user, { recursive: true });
    fs.mkdirSync(path.join(applications, "UltraStar Deluxe.app"));
    const renamed = fakeGameApp(applications, "UltraStar Deluxe 2025", "ultrastardx", SCRIPT);
    fakeGameApp(applications, "UltraStar Manager", "manager", SCRIPT);
    const tunePerfect = fakeGameApp(user, "Tune Perfect", "tuneperfect", SCRIPT);
    const platform = { os: "darwin" as const, home: path.join(dir, "home"), env: {}, appFolders: [applications, user] };
    expect(await run(findGame("usdx", platform))).toBe(renamed);
    expect(await run(findGame("tune-perfect", platform))).toBe(tunePerfect);
    expect(await run(findGame("vocaluxe", platform))).toBeNull();
  });

  it("finds a program on the PATH (Linux) or where its installer puts it (Windows)", async () => {
    const dir = temp();
    const bin = path.join(dir, "bin");
    fs.mkdirSync(bin);
    fs.writeFileSync(path.join(bin, "performous"), SCRIPT, { mode: 0o755 });
    const linux = { os: "linux" as const, home: dir, env: { PATH: `/nowhere:${bin}` } };
    expect(await run(findGame("performous", linux))).toBe(path.join(bin, "performous"));
    expect(await run(findGame("usdx", linux))).toBeNull();

    const programs = path.join(dir, "Program Files (x86)");
    fs.mkdirSync(path.join(programs, "UltraStar Deluxe"), { recursive: true });
    fs.writeFileSync(path.join(programs, "UltraStar Deluxe", "ultrastardx.exe"), "MZ");
    const windows = { os: "win32" as const, home: dir, env: { "ProgramFiles(x86)": programs } };
    expect(await run(findGame("usdx", windows))).toBe(path.join(programs, "UltraStar Deluxe", "ultrastardx.exe"));
    expect(await run(findGame("tune-perfect", windows))).toBeNull();
  });
});

describe("gameLauncherLayer", () => {
  const start = (program: string, args: string[], env: Record<string, string> = {}) =>
    Effect.runPromise(
      GameLauncher.use((launcher) => launcher.start(program, args, { PATH: "/usr/bin:/bin", ...env })).pipe(
        Effect.provide(gameLauncherLayer),
      ),
    );

  it("starts the program with the arguments and environment, and lets it run on", async () => {
    const dir = temp();
    const out = path.join(dir, "argv.txt");
    const game = path.join(dir, "game");
    const script = `#!/bin/sh\nprintf '%s\\n' "$@" "env:$TRY_MARK:$ELECTRON_RUN_AS_NODE" > "${out}.part"\nmv "${out}.part" "${out}"\nsleep 5\n`;
    fs.writeFileSync(game, script, { mode: 0o755 });
    expect(await start(game, ["--songpath", "/a folder/Song"], { TRY_MARK: "x" })).toEqual({ kind: "started" });
    await expect.poll(() => fs.existsSync(out)).toBe(true);
    expect(fs.readFileSync(out, "utf8")).toBe("--songpath\n/a folder/Song\nenv:x:\n");
  });

  it("says when the program is missing or not allowed", async () => {
    const dir = temp();
    expect(await start(path.join(dir, "nothing"), [])).toEqual({ kind: "failed", code: "ENOENT" });
    const locked = path.join(dir, "locked");
    fs.writeFileSync(locked, SCRIPT, { mode: 0o644 });
    expect(await start(locked, [])).toEqual({ kind: "failed", code: "EACCES" });
  });
});

/**
 * "Try in game": the karaoke games a song can be tried in, where they are, and starting one with a song folder. As
 * USDB Syncer does, the game's program is started with its own song folder option and the song's folder.
 */
import { Context, Effect, FileSystem, Layer, Path, Semaphore } from "effect";
import type { ChildProcessSpawner } from "effect/process";

import { GAME_NAMES, GAMES, type Game } from "../../src/lib/games";
import type { GamesStatus } from "../../src/lib/native/types";
import { type FileError, GameNotFound, GameUnusable, mapFileError, quoted } from "../errors";
import { AppSettings } from "../services/settings";
import { GameLauncher } from "./launcher";
import { readInfoPlist } from "./plist";

/**
 * The game's arguments for a song folder. Each game also finds a song in the folder it is given (they all look
 * through the folders below too), and only Tune Perfect, Vocaluxe and Performous then show just that one; UltraStar
 * Deluxe adds it to its own song folders.
 */
export function launchArgs(game: Game, folder: string): string[] {
  switch (game) {
    case "tune-perfect":
      return ["--songpath", folder];
    case "usdx":
      return ["-songpath", folder];
    case "vocaluxe":
      return ["-SongFolder", folder];
    case "performous":
      // Song folders are its arguments without an option.
      return [folder];
  }
}

/** Variables Electron and the app set for themselves, which would change how another program (even Electron) runs. */
const OWN_VARIABLES = /^(ELECTRON_|TUNESTUDIO_|NODE_OPTIONS$|CHROME_DESKTOP$|__CFBundleIdentifier$)/;
/** An AppImage's own; its programs would think they run inside it. */
const APPIMAGE_VARIABLES = new Set(["APPDIR", "APPIMAGE", "ARGV0", "OWD"]);

/** The environment a game starts with: the app's, without what Electron and Tune Studio set for themselves. */
export function cleanEnv(env: Record<string, string | undefined>): Record<string, string> {
  const clean: Record<string, string> = {};
  for (const [key, value] of Object.entries(env)) {
    if (value === undefined || OWN_VARIABLES.test(key) || APPIMAGE_VARIABLES.has(key)) continue;
    clean[key] = value;
  }
  return clean;
}

/** Where the games usually are, and the platform's ways. */
export interface GamePlatform {
  readonly os: NodeJS.Platform;
  readonly home: string;
  /** The app's environment (PATH, the program folders on Windows). */
  readonly env: Record<string, string | undefined>;
  /** Where macOS apps are looked for; `/Applications` and `~/Applications` by default. */
  readonly appFolders?: readonly string[];
}

/** How an app's name on macOS reads when matched: lower case, letters and digits only. */
const squash = (name: string) => name.toLowerCase().replace(/[^a-z\d]/g, "");

/** What the games' macOS bundles are called (squashed), also when renamed ("UltraStar Deluxe 2025.app"). */
const BUNDLE_NAMES: Record<Game, string[]> = {
  "tune-perfect": ["tuneperfect"],
  usdx: ["ultrastardeluxe", "ultrastardx", "usdx"],
  vocaluxe: ["vocaluxe"],
  performous: ["performous"],
};

/** The programs on Linux, looked for on the PATH. */
const LINUX_PROGRAMS: Record<Game, string[]> = {
  "tune-perfect": ["tuneperfect", "tune-perfect"],
  usdx: ["ultrastardx"],
  vocaluxe: ["vocaluxe", "Vocaluxe"],
  performous: ["performous"],
};

/** Where Windows installers put them: a folder variable and the path under it. */
const WINDOWS_PROGRAMS: Record<Game, [variable: string, ...path: string[]][]> = {
  "tune-perfect": [["LOCALAPPDATA", "Programs", "Tune Perfect", "Tune Perfect.exe"]],
  usdx: [
    ["ProgramFiles(x86)", "UltraStar Deluxe", "ultrastardx.exe"],
    ["ProgramFiles", "UltraStar Deluxe", "ultrastardx.exe"],
  ],
  vocaluxe: [
    ["ProgramFiles", "Vocaluxe", "Vocaluxe.exe"],
    ["ProgramFiles(x86)", "Vocaluxe", "Vocaluxe.exe"],
  ],
  performous: [
    ["ProgramFiles", "Performous", "performous.exe"],
    ["ProgramFiles(x86)", "Performous", "performous.exe"],
  ],
};

const unusable = (message: string) => new GameUnusable({ message });

/**
 * The program to start for an app the user chose (or one found): inside a macOS `.app`, the one its `Info.plist`
 * names (`CFBundleExecutable`); elsewhere the file itself, which has to be one that runs. Fails with why it can't be
 * used.
 */
export function programOf(app: string, os: NodeJS.Platform) {
  return Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const paths = yield* Path.Path;
    const name = quoted(paths.basename(app));
    const info = yield* fs.stat(app).pipe(Effect.orElseSucceed(() => null));
    if (!info) return yield* unusable(`${name} doesn't exist anymore.`);

    if (os === "darwin" && app.toLowerCase().endsWith(".app")) {
      if (info.type !== "Directory") return yield* unusable(`${name} isn't an app.`);
      const plist = yield* readInfoPlist(app);
      const executable = plist?.get("CFBundleExecutable");
      // A name in Contents/MacOS, never a path out of it.
      if (!executable || /[/\\]/.test(executable) || executable === "." || executable === "..") {
        return yield* unusable(`${name} doesn't say which program to start.`);
      }
      const program = paths.join(app, "Contents", "MacOS", executable);
      const inside = yield* fs.stat(program).pipe(Effect.orElseSucceed(() => null));
      if (inside?.type !== "File" || (inside.mode & 0o111) === 0) {
        return yield* unusable(`${name} is missing its program.`);
      }
      return program;
    }

    if (info.type !== "File") {
      return yield* unusable(os === "darwin" ? `${name} isn't an app.` : `${name} isn't a program.`);
    }
    if (os === "win32" ? !app.toLowerCase().endsWith(".exe") : (info.mode & 0o111) === 0) {
      return yield* unusable(`${name} isn't a program.`);
    }
    return app;
  });
}

/** Where the game usually is: an app in the Applications folders (macOS), its install folder (Windows), the PATH. */
export function findGame(game: Game, platform: GamePlatform) {
  return Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const paths = yield* Path.Path;
    const usable = (app: string) =>
      programOf(app, platform.os).pipe(
        Effect.as(true),
        Effect.orElseSucceed(() => false),
      );

    if (platform.os === "darwin") {
      for (const folder of platform.appFolders ?? ["/Applications", paths.join(platform.home, "Applications")]) {
        const entries = yield* fs.readDirectory(folder).pipe(Effect.orElseSucceed((): string[] => []));
        // The game's own name first, then renamed copies, in name order.
        const names = BUNDLE_NAMES[game];
        const rank = (entry: string) => (names.includes(squash(entry.slice(0, -4))) ? 0 : 1);
        const apps = entries
          .filter((entry) => entry.toLowerCase().endsWith(".app"))
          .filter((entry) => names.some((name) => squash(entry.slice(0, -4)).includes(name)))
          .toSorted((a, b) => rank(a) - rank(b) || a.localeCompare(b));
        for (const entry of apps) {
          const app = paths.join(folder, entry);
          if (yield* usable(app)) return app;
        }
      }
      return null;
    }

    const candidates =
      platform.os === "win32"
        ? WINDOWS_PROGRAMS[game].flatMap(([variable, ...path]) => {
            const base = platform.env[variable];
            return base ? [paths.join(base, ...path)] : [];
          })
        : (platform.env.PATH ?? "")
            .split(":")
            .filter((folder) => folder !== "")
            .flatMap((folder) => LINUX_PROGRAMS[game].map((name) => paths.join(folder, name)));
    for (const candidate of candidates) {
      if (yield* usable(candidate)) return candidate;
    }
    return null;
  });
}

interface GamesShape {
  /** Each game's chosen app and the one "Try in game" would start. */
  readonly status: Effect.Effect<GamesStatus>;
  /** Keeps `app` for `game` after checking it can be started. */
  readonly choose: (game: Game, app: string) => Effect.Effect<GamesStatus, GameUnusable | FileError>;
  readonly clear: (game: Game) => Effect.Effect<GamesStatus, FileError>;
  /** The game "Try in game" starts from now on. */
  readonly use: (game: Game) => Effect.Effect<GamesStatus, FileError>;
  /**
   * Exports a song with `exportInto` into Tune Studio's own folder (emptied first: only the last try is kept) and
   * starts the game the settings name with the folder it returns. One try at a time.
   */
  readonly tryOut: <E, R>(
    exportInto: (folder: string) => Effect.Effect<string, E, R>,
  ) => Effect.Effect<{ game: Game; folder: string }, E | GameNotFound | GameUnusable | FileError, R>;
}

/** The games and the folder songs are tried from. */
export class Games extends Context.Service<Games, GamesShape>()("studio/Games") {}

/** The games, with tries in `folder` (in the app's data directory). */
export function gamesLayer(options: { folder: string; platform: GamePlatform }) {
  return Layer.effect(
    Games,
    Effect.gen(function* () {
      const settings = yield* AppSettings;
      const launcher = yield* GameLauncher;
      const fs = yield* FileSystem.FileSystem;
      const lock = yield* Semaphore.make(1);
      const { os } = options.platform;
      type Platform = FileSystem.FileSystem | Path.Path | ChildProcessSpawner.ChildProcessSpawner;
      const platform = yield* Effect.context<Platform>();
      const run = <A, E>(effect: Effect.Effect<A, E, Platform>) => Effect.provide(effect, platform);

      /** The app to start for `game`: the chosen one if it can be, else one found. */
      const appFor = (game: Game, chosen: string | null) =>
        Effect.gen(function* () {
          if (chosen) {
            const ok = yield* run(programOf(chosen, os)).pipe(
              Effect.as(true),
              Effect.orElseSucceed(() => false),
            );
            if (ok) return chosen;
          }
          return yield* run(findGame(game, options.platform));
        });

      const statusOf = (stored: { tryWith: Game; paths: Record<Game, string | null> }) =>
        Effect.gen(function* () {
          const games = yield* Effect.forEach(
            GAMES,
            (game) =>
              Effect.map(appFor(game, stored.paths[game]), (found) => ({
                game,
                chosen: stored.paths[game],
                found,
              })),
            { concurrency: "unbounded" },
          );
          return { tryWith: stored.tryWith, games } satisfies GamesStatus;
        });

      const status = Effect.flatMap(settings.get, (stored) => statusOf(stored.games));

      return {
        status,
        choose: (game, app) =>
          Effect.gen(function* () {
            yield* run(programOf(app, os));
            const stored = yield* settings.setGames({ paths: { [game]: app } });
            return yield* statusOf(stored.games);
          }),
        clear: (game) =>
          Effect.flatMap(settings.setGames({ paths: { [game]: null } }), (stored) => statusOf(stored.games)),
        use: (game) => Effect.flatMap(settings.setGames({ tryWith: game }), (stored) => statusOf(stored.games)),
        tryOut: (exportInto) =>
          lock.withPermits(1)(
            Effect.gen(function* () {
              const { games } = yield* settings.get;
              const game = games.tryWith;
              const name = GAME_NAMES[game];
              const chosen = games.paths[game];
              // Nothing is exported when there is no game to start.
              const app = yield* appFor(game, chosen);
              if (!app) {
                return yield* new GameNotFound({
                  message: chosen
                    ? `${name} isn't where it was chosen. Choose it again in Settings.`
                    : `Tune Studio couldn't find ${name}. Choose it in Settings.`,
                });
              }
              const program = yield* run(programOf(app, os));

              const what = "the song for the game";
              yield* fs.remove(options.folder, { recursive: true, force: true }).pipe(mapFileError(what, "replace"));
              yield* fs.makeDirectory(options.folder, { recursive: true }).pipe(mapFileError(what, "write"));
              const folder = yield* exportInto(options.folder);

              const outcome = yield* launcher.start(program, launchArgs(game, folder), cleanEnv(options.platform.env));
              if (outcome.kind === "failed") {
                return yield* new GameUnusable({
                  message:
                    outcome.code === "EACCES"
                      ? `Tune Studio isn't allowed to start ${name}. Check that it is a program you can run.`
                      : outcome.code === "ENOENT"
                        ? `${name} isn't where it was chosen. Choose it again in Settings.`
                        : `${name} didn't start (${outcome.code}).`,
                });
              }
              if (outcome.kind === "exited") {
                return yield* new GameUnusable({
                  message: `${name} closed right away. If it was open already, quit it and try again.`,
                });
              }
              return { game, folder };
            }),
          ),
      } satisfies GamesShape;
    }),
  );
}

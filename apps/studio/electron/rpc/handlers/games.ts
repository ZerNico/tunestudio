/** "Try in game": which games there are, choosing one's app, and trying a project's song in one. */
import { Effect } from "effect";

import { GAME_NAMES } from "../../../src/lib/games";
import { Games } from "../../games/games";
import { Desktop } from "../../services/desktop";
import { syncSong } from "../../ultrastar/song-export";
import { type GroupHandlers, windowOf, withProject } from "./shared";

export const gameHandlers = {
  "games.status": () => Games.use((games) => games.status),
  // The path comes from main's own dialog, never from the renderer: what is started is only what the user picked.
  "games.choose": (input, { client }) =>
    Effect.gen(function* () {
      const games = yield* Games;
      const desktop = yield* Desktop;
      const app = yield* desktop.chooseGame(yield* windowOf(client), `Choose ${GAME_NAMES[input.game]}`);
      if (app === null) return yield* games.status;
      return yield* games.choose(input.game, app);
    }),
  "games.clear": (input) => Games.use((games) => games.clear(input.game)),
} satisfies GroupHandlers<"games">;

export const tryHandlers = {
  "project.tryInGame": (input) =>
    Effect.gen(function* () {
      let warnings: readonly string[] = [];
      const tried = yield* Games.use((games) =>
        games.tryOut(input.game, (folder) =>
          withProject(input.id, (session) => syncSong(session, folder)).pipe(
            Effect.map((result) => {
              warnings = result.warnings;
              return result.folder;
            }),
          ),
        ),
      );
      return { ...tried, warnings };
    }),
} satisfies Pick<GroupHandlers<"project">, "project.tryInGame">;

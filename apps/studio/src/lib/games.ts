/**
 * The karaoke games "Try in game" can open a song in (`electron/games/`), shared by the settings and the editor.
 * Tune Perfect comes first: it is the game Tune Studio is made for.
 */
export const GAMES = ["tune-perfect", "usdx", "vocaluxe", "performous"] as const;
export type Game = (typeof GAMES)[number];

export const GAME_NAMES: Record<Game, string> = {
  "tune-perfect": "Tune Perfect",
  usdx: "UltraStar Deluxe",
  vocaluxe: "Vocaluxe",
  performous: "Performous",
};

/** The menu item that tries the song in `game`. */
export function tryLabel(game: Game): string {
  return `Try in ${GAME_NAMES[game]}`;
}

/** A game "Try in game" can start: its app is chosen and can be started, or one was found. */
export function isAvailable(status: { found: string | null }): boolean {
  return status.found !== null;
}

/**
 * The game Mod+T (and the plain "Try in game") starts: the one tried last if it is still available, else the first
 * available one; null when there is none.
 */
export function defaultGame(status: {
  last: Game | null;
  games: readonly { game: Game; found: string | null }[];
}): Game | null {
  const available = new Set(status.games.filter(isAvailable).map((entry) => entry.game));
  if (status.last && available.has(status.last)) return status.last;
  return GAMES.find((game) => available.has(game)) ?? null;
}

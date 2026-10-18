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

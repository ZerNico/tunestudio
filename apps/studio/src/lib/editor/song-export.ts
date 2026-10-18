/**
 * Exporting the song from the editor: as a song folder for games (asking where; a folder already there is replaced
 * only after asking, `replacing`), or as the chart's text for USDB; or trying it in a game (exported into Tune
 * Studio's own folder and the game started with it). Each saves the edits so far first, so the file has the latest,
 * and ends with a toast.
 */
import { createSignal } from "solid-js";

import { toast, toastError } from "~/components/ui/toast";
import { revealLabel } from "~/lib/desktop";
import { GameNotFound } from "~/lib/errors";
import { songFileName } from "~/lib/file-names";
import { defaultGame, GAME_NAMES, type Game, isAvailable } from "~/lib/games";
import { native } from "~/lib/native/client";
import { errorMessage } from "~/lib/native/errors";
import type { EditorSong, GamesStatus } from "~/lib/native/types";

/** Shows a file or folder in Finder or Explorer. */
export function reveal(path: string) {
  native.files.reveal({ path }).catch((error: unknown) => toastError("Couldn't show the file", error));
}

export function createSongExport(options: {
  project: () => string;
  song: () => EditorSong;
  /** Waits for the edits so far to be saved. */
  saved: () => Promise<void>;
  /** Shows the settings' Games section (no game to try the song in). */
  openGameSettings: () => void;
}) {
  const [exporting, setExporting] = createSignal(false);
  /** The games as main said when last asked; null until it has. */
  const [games, setGames] = createSignal<GamesStatus | null>(null);
  /** A song folder that is there already, asked about before it's replaced. */
  const [replacing, setReplacing] = createSignal<{ folder: string; existing: string } | null>(null);

  /** Asks main which games there are (one may have been added in the settings, in another window too). */
  const refreshGames = () => {
    native.games.status().then(setGames, (error: unknown) => console.error(error));
  };

  /** Exports into `folder`, replacing a song folder there only with `replace`. */
  const exportTo = async (folder: string, replace: boolean) => {
    setExporting(true);
    try {
      await options.saved();
      const result = await native.project.exportSong({ id: options.project(), folder, replace });
      if (result.status === "exists") {
        setReplacing({ folder, existing: result.folder });
        return;
      }
      toast.add({
        type: "success",
        title: "Exported for games",
        description: [result.folder, ...result.warnings].join(" "),
        actionProps: { children: revealLabel, onClick: () => reveal(result.folder) },
      });
    } catch (error) {
      toastError("Couldn't export the song", error);
    } finally {
      setExporting(false);
    }
  };

  return {
    exporting,
    replacing,
    /** The games a song can be tried in, in `GAMES` order. */
    available: (): Game[] =>
      games()
        ?.games.filter(isAvailable)
        .map((entry) => entry.game) ?? [],
    /** The game Mod+T starts (`defaultGame`); null when there is none or main wasn't asked yet. */
    defaultGame: (): Game | null => {
      const status = games();
      return status ? defaultGame(status) : null;
    },

    refreshGames,

    /**
     * Exports the song into Tune Studio's own folder and opens `game` with it; without one, the game main picks: the
     * one tried last, else the first available.
     */
    async tryInGame(game?: Game) {
      if (exporting()) return;
      setExporting(true);
      const title = game ? `Couldn't open ${GAME_NAMES[game]}` : "Couldn't open a game";
      try {
        await options.saved();
        const result = await native.project.tryInGame({ id: options.project(), game });
        setGames((status) => status && { ...status, last: result.game });
        toast.add({
          type: "success",
          title: `Opened in ${GAME_NAMES[result.game]}`,
          description: result.warnings.join(" ") || undefined,
        });
      } catch (error) {
        if (error instanceof GameNotFound) {
          // The menu's games may be old.
          refreshGames();
          toast.add({
            type: "error",
            title,
            description: errorMessage(error),
            actionProps: { children: "Open Settings", onClick: () => options.openGameSettings() },
          });
        } else {
          toastError(title, error);
        }
      } finally {
        setExporting(false);
      }
    },

    /** Asks where, then exports for games. */
    async forGames() {
      try {
        const folder = await native.dialogs.chooseExportFolder();
        if (folder) await exportTo(folder, false);
      } catch (error) {
        toastError("Couldn't export the song", error);
      }
    },

    /** The song folder that was there is replaced after all. */
    replace(folder: string) {
      setReplacing(null);
      void exportTo(folder, true);
    },
    cancelReplace: () => setReplacing(null),

    /** Asks where to save the chart's text for USDB, and writes it there. */
    async forUsdb() {
      setExporting(true);
      try {
        const song = options.song();
        const path = await native.dialogs.chooseUsdbFile({ name: songFileName(song.artist, song.title) });
        if (!path) return;
        await options.saved();
        const { warnings } = await native.project.exportUsdb({ id: options.project(), path });
        toast.add({
          type: "success",
          title: "Exported for USDB",
          description: [path, ...warnings].join(" "),
          actionProps: { children: revealLabel, onClick: () => reveal(path) },
        });
      } catch (error) {
        toastError("Couldn't export the text for USDB", error);
      } finally {
        setExporting(false);
      }
    },
  };
}

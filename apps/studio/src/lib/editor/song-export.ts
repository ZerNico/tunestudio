/**
 * Exporting the song from the editor: as a song folder for games (asking where; a folder already there is replaced
 * only after asking, `replacing`), or as the chart's text for USDB. Either saves the edits so far first, so the file
 * has the latest, and ends with a toast that can show the file.
 */
import { createSignal } from "solid-js";

import { toast, toastError } from "~/components/ui/toast";
import { revealLabel } from "~/lib/desktop";
import { songFileName } from "~/lib/file-names";
import { native } from "~/lib/native/client";
import type { EditorSong } from "~/lib/native/types";

/** Shows a file or folder in Finder or Explorer. */
export function reveal(path: string) {
  native.files.reveal({ path }).catch((error: unknown) => toastError("Couldn't show the file", error));
}

export function createSongExport(options: {
  project: () => string;
  song: () => EditorSong;
  /** Waits for the edits so far to be saved. */
  saved: () => Promise<void>;
}) {
  const [exporting, setExporting] = createSignal(false);
  /** A song folder that is there already, asked about before it's replaced. */
  const [replacing, setReplacing] = createSignal<{ folder: string; existing: string } | null>(null);

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

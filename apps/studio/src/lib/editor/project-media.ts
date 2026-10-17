/**
 * The project's media files from the editor: its cover and background (`artwork`), replacing a file or removing the
 * video, and separating the voice from the song again (`separating` while it runs). The overview is only read when the
 * project opens, and reading it again would start the editor over, so the media as changed since are kept here.
 */
import { createSignal } from "solid-js";

import type { ArtworkActions } from "~/components/editor/song-artwork";
import type { MediaActions } from "~/components/editor/song-files";
import { toast, toastError } from "~/components/ui/toast";
import { native } from "~/lib/native/client";
import { follow as followProgress } from "~/lib/native/progress";
import type { ImportProgress, ProjectOverview } from "~/lib/native/types";

export function createProjectMedia(options: {
  overview: () => ProjectOverview;
  /** The song's artist and title, to find covers for. */
  song: () => { artist: string; title: string };
  /** The song's length in seconds, or 0 while unknown. */
  duration: () => number;
}) {
  const [changed, setChanged] = createSignal<ProjectOverview["media"] | null>(null);
  const media = () => changed() ?? options.overview().media;
  const id = () => options.overview().id;

  const artwork: ArtworkActions = {
    set: async (role, choice) => {
      const updated = await native.project.setArtwork({ id: id(), role, choice });
      setChanged(updated.media);
    },
    findCovers: () =>
      native.youtube.findCovers({
        artist: options.song().artist,
        title: options.song().title,
        duration: options.duration() || null,
      }),
    chooseImage: () => native.dialogs.chooseCoverImage(),
    onError: (title, error) => {
      toastError(title, error);
    },
  };

  /** Separating the voice from the song again, while it runs. */
  const [separating, setSeparating] = createSignal<ImportProgress | null | undefined>(undefined);
  let separation: AbortController | undefined;
  const stopSeparating = () => {
    separation?.abort();
    setSeparating(undefined);
  };

  const files: MediaActions = {
    chooseFile: (kind) => native.dialogs.chooseMediaFile({ kind }),
    replace: async (role, path) => {
      const updated = await native.project.replaceMedia({ id: id(), role, path });
      setChanged(updated.media);
    },
    removeVideo: async () => {
      const updated = await native.project.removeVideo({ id: id() });
      setChanged(updated.media);
    },
    separating,
    separate: () => {
      if (separating() !== undefined) return;
      const controller = new AbortController();
      separation = controller;
      setSeparating(null);
      followProgress(
        () => native.project.separate({ id: id() }, { signal: controller.signal }),
        controller.signal,
        setSeparating,
        // Stopped just as it finished: the new files are in, so the editor plays them.
        (late) => setChanged(late.media),
      )
        .then((updated) => {
          if (!updated) return;
          setChanged(updated.media);
          toast.add({ type: "success", title: "Separated the voice from the song" });
        })
        .catch((error: unknown) => toastError("Couldn't separate the voice", error))
        .finally(() => {
          if (separation === controller) setSeparating(undefined);
        });
    },
    stopSeparating,
    onError: (title, error) => {
      toastError(title, error);
    },
  };

  return { media, artwork, files, separating, stopSeparating };
}

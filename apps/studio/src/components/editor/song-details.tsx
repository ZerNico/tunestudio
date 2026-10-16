/**
 * The song details dialog as the editor uses it: its fields as edits to the chart, the song's files (the cover in its
 * own dialog), the timing markers and the lyrics, wired to the document, the markers and playback.
 */
import { createSignal } from "solid-js";

import type { LineSpan } from "~/lib/editor/chart";
import type { ChartDocument } from "~/lib/editor/document";
import type { SongMarkers } from "~/lib/editor/song-markers";
import type { EditorChart, LyricsLine, ProjectMedia } from "~/lib/native/types";

import { type ArtworkActions, CoverDialog } from "./song-artwork";
import { SongDetailsDialog } from "./song-details-dialog";
import { SongFiles } from "./song-files";
import { SongTiming } from "./song-timing";

export function SongDetails(props: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  doc: ChartDocument<number[]>;
  chart: EditorChart;
  media: readonly ProjectMedia[];
  artwork: ArtworkActions;
  markers: SongMarkers;
  /** The lines of the selected notes (the medley is set from them). */
  selectedLines: () => readonly LineSpan[];
  playheadTime: () => number;
  /** Plays from `seconds`. */
  onPlayFrom: (seconds: number) => void;
  lyrics?: readonly LyricsLine[];
}) {
  const [coverOpen, setCoverOpen] = createSignal(false);
  const edit = (label: string, build: Parameters<ChartDocument<number[]>["edit"]>[1]) => props.doc.edit(label, build);
  return (
    <SongDetailsDialog
      open={props.open}
      onOpenChange={props.onOpenChange}
      song={props.chart.song}
      bpm={props.chart.bpm}
      gap={props.chart.gap}
      singers={props.chart.singers}
      otherHeaders={props.chart.song.otherHeaders}
      onChange={(label, patch) => edit(label, (tx) => tx.updateSong(patch))}
      onSingerName={(id, name) => edit("Change singer's name", (tx) => tx.updateSinger(id, name))}
      files={<SongFiles media={props.media} actions={props.artwork} onChangeCover={() => setCoverOpen(true)} />}
      nested={
        <CoverDialog
          open={coverOpen()}
          onOpenChange={setCoverOpen}
          url={props.media.find((item) => item.role === "cover")?.url}
          actions={props.artwork}
        />
      }
      timing={
        <SongTiming
          song={props.chart.song}
          hasVideo={props.media.some((item) => item.role === "video")}
          hasSelection={props.selectedLines().length > 0}
          playheadTime={props.playheadTime}
          actions={{
            set: (marker, seconds) => props.markers.set(marker, seconds),
            setMedleyFromSelection: () => {
              const lines = props.selectedLines();
              props.markers.setMedley(lines);
              return lines.length > 0;
            },
            clear: (marker) => props.markers.clear(marker),
            playFrom: (seconds) => props.onPlayFrom(seconds),
            setVideoGap: (seconds) => edit("Change video offset", (tx) => tx.updateSong({ videoGap: seconds })),
          }}
        />
      }
      lyrics={props.lyrics}
    />
  );
}

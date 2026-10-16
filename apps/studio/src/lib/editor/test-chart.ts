import type { EditorNote, EditorSong, NoteType } from "~/lib/native/types";

/** Song details for test charts: a title and artist, nothing else set. */
export const testSong: EditorSong = {
  title: "Night Signals",
  artist: "Test Artist",
  language: ["English"],
  year: null,
  genre: null,
  edition: null,
  creator: null,
  tags: [],
  otherHeaders: [],
  videoGap: null,
  start: null,
  end: null,
  previewStart: null,
  medleyStart: null,
  medleyEnd: null,
};

/** A note for test charts: E4, normal, not edited, 0.3 s unless said. */
export function testNote(
  id: number,
  start: number,
  lyric = "la",
  duration = 0.3,
  type: NoteType = "normal",
): EditorNote {
  return { id, start, duration, pitch: 64, lyric, type, edited: false };
}

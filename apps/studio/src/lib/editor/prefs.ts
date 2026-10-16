/**
 * The editor's listening settings, the same in every project and remembered (localStorage): whether the view follows
 * the playhead (on at first), whether notes are heard as tones (off at first), and the song's and the tones' volume.
 */
import { Schema } from "effect";

import { createStored, onOff, type StoredFormat } from "~/lib/stored";

/** How loud the song (whichever source plays) and the tones are, 0-1. */
export interface Volumes {
  song: number;
  tones: number;
}

const FULL: Volumes = { song: 1, tones: 1 };

const Volume = Schema.Number.check(Schema.isBetween({ minimum: 0, maximum: 1 }));
const isVolume = Schema.is(Volume);

/** JSON; each volume that is missing or isn't one is full. */
const volumesFormat: StoredFormat<Volumes> = {
  read: (text) => {
    let stored: unknown;
    try {
      stored = JSON.parse(text);
    } catch {
      return undefined;
    }
    const values = typeof stored === "object" && stored !== null ? (stored as Record<string, unknown>) : {};
    return {
      song: isVolume(values.song) ? values.song : FULL.song,
      tones: isVolume(values.tones) ? values.tones : FULL.tones,
    };
  },
  write: (value) => JSON.stringify(value),
};

export function createEditorPrefs() {
  const [following, setFollowing] = createStored("tunestudio.editor.follow", onOff, true);
  const [tones, setTones] = createStored("tunestudio.editor.tones", onOff, false);
  const [volumes, setVolumes] = createStored("tunestudio.editor.volumes", volumesFormat, FULL);
  return {
    following,
    setFollowing,
    tones,
    setTones,
    volumes,
    setVolume: (channel: keyof Volumes, value: number) => setVolumes({ ...volumes(), [channel]: value }),
  };
}

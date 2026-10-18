/**
 * The editor's keys as shown: the help lists them, and tooltips and the note menu show them from here, so what they
 * show agrees. The key handling (`note-editing.ts`, `break-editing.ts`, the editor screen) matches its own keys: a key
 * changed there is changed here too. Keys are written with `Mod` for Cmd on macOS and Ctrl elsewhere (`shown`). The
 * tools' and note types' keys come from their own tables (`TOOLS`, `NOTE_FLAGS`), which the key handling reads.
 */
import { platform } from "~/lib/desktop";

import { NOTE_FLAGS } from "./edits";
import { TOOLS } from "./tools";

export interface Shortcut {
  /** One way to press it, or several ("↑ / ↓"). */
  keys: readonly string[];
  /** What it does. */
  does: string;
}

export const SHORTCUTS = {
  play: { keys: ["Space"], does: "Play or pause" },
  lines: { keys: [",", "."], does: "Previous or next line" },
  fitLine: { keys: ["Z"], does: "Fit the current line on screen" },
  loop: { keys: ["L"], does: "Loop on or off (with notes selected: loop them)" },
  undo: { keys: ["Mod+Z"], does: "Undo" },
  redo: { keys: ["Mod+Shift+Z", "Mod+Y"], does: "Redo" },
  pitch: { keys: ["↑", "↓"], does: "Pitch a semitone up or down (Shift: an octave)" },
  move: { keys: ["←", "→"], does: "Move a grid step earlier or later" },
  length: { keys: ["Shift+←", "Shift+→"], does: "Shorter or longer by a grid step" },
  nextNote: { keys: ["Tab", "Shift+Tab"], does: "Next or previous note" },
  syllable: { keys: ["Enter"], does: "Type the selected note's syllable" },
  delete: { keys: ["Delete"], does: "Delete the selection" },
  merge: { keys: ["M"], does: "Merge the selected notes" },
  autoPitch: { keys: ["A"], does: "Auto pitch the selected notes" },
  lineBreak: { keys: ["B"], does: "Line break after the selection, or at the playhead" },
  splitAtPlayhead: { keys: ["Mod+K"], does: "Split at the playhead" },
  selectAll: { keys: ["Mod+A"], does: "Select everything" },
  deselect: { keys: ["Esc"], does: "Stop a drag, back to Select, then deselect" },
  cut: { keys: ["Mod+X"], does: "Cut" },
  copy: { keys: ["Mod+C"], does: "Copy" },
  paste: { keys: ["Mod+V"], does: "Paste at the playhead" },
  tryInGame: { keys: ["Mod+T"], does: "Try the song in a game" },
  help: { keys: ["?"], does: "This help" },
} as const satisfies Record<string, Shortcut>;

export type ShortcutId = keyof typeof SHORTCUTS;

/** A key as shown on this computer: "⌘K" on macOS, "Ctrl+K" elsewhere. */
export function shown(key: string): string {
  if (platform === "macos")
    return key === "Delete" ? "⌫" : key.replace("Mod+Shift+", "⇧⌘").replace("Mod+", "⌘").replace("Shift+", "⇧");
  return key === "Delete" ? "Del" : key.replace("Mod+", "Ctrl+");
}

/** A shortcut's first key, as shown (for tooltips and menus). */
export function keyOf(id: ShortcutId): string {
  return shown(SHORTCUTS[id].keys[0]!);
}

/** The help's rows for these shortcuts: their keys as shown, and what they do. */
const rows = (...ids: ShortcutId[]) =>
  ids.map((id) => ({ keys: SHORTCUTS[id].keys.map(shown), does: SHORTCUTS[id].does }));

/** The help's list: groups of shortcuts, each a row of keys and what they do. */
export function shortcutGroups(): { title: string; rows: { keys: string[]; does: string }[] }[] {
  return [
    { title: "Listening", rows: rows("play", "lines", "fitLine", "loop") },
    {
      title: "Notes",
      rows: [
        ...rows("pitch", "move", "length", "nextNote", "syllable", "merge", "autoPitch", "splitAtPlayhead"),
        ...NOTE_FLAGS.map((flag) => ({ keys: [flag.key], does: `${flag.label} on or off` })),
      ],
    },
    { title: "Tools", rows: [...TOOLS.map((tool) => ({ keys: [tool.key], does: tool.label })), ...rows("help")] },
    { title: "Lines", rows: rows("lineBreak") },
    { title: "Editing", rows: rows("undo", "redo", "selectAll", "deselect", "delete", "cut", "copy", "paste") },
    { title: "Song", rows: rows("tryInGame") },
  ];
}

/**
 * The chart the editor works on, and the one way to change it: `edit(label, (tx) => …)`. The edit's changes are
 * recorded (every row as it was and as it becomes), applied to the editor's rows at once, added to the history, and
 * saved to the project in order behind the scenes. Undo and redo go through the same apply-and-save.
 *
 * If saving fails (the disk is full, the project disagrees), the history is dropped and `onFailed` reloads the chart
 * from the project, so what the editor shows never differs from what is saved for long.
 */
import { createMemo, createSignal, createStore, flush } from "solid-js";

import type { ChartChange, LineFields, NoteFields, SongFields } from "~/lib/native/contract";
import type { EditorChart, EditorLine } from "~/lib/native/types";

import { createHistory, invert } from "./history";

/** The chart as rows, the way the project stores it. */
export interface ChartRows {
  song: { bpm: number; gap: number } & SongFields;
  singers: { id: number; index: number; name: string | null }[];
  lines: Record<number, LineFields & { id: number }>;
  notes: Record<number, NoteFields & { id: number }>;
}

export function rowsFromChart(chart: EditorChart): ChartRows {
  const rows: ChartRows = {
    song: { bpm: chart.bpm, gap: chart.gap },
    singers: chart.singers.map(({ id, index, name }) => ({ id, index, name })),
    lines: {},
    notes: {},
  };
  for (const singer of chart.singers) {
    for (const line of singer.lines) {
      rows.lines[line.id] = {
        id: line.id,
        singerId: singer.id,
        switchStart: line.switchStart,
        switchEnd: line.switchEnd,
      };
      for (const note of line.notes) rows.notes[note.id] = { ...note, lineId: line.id };
    }
  }
  return rows;
}

/** The rows as the tree the editor draws: lines by their first note, notes by start (as the project orders them). */
export function chartFromRows(rows: ChartRows): EditorChart {
  const byLine = new Map<number, EditorLine["notes"]>();
  for (const note of Object.values(rows.notes)) {
    const { lineId, ...rest } = note;
    byLine.set(lineId, [...(byLine.get(lineId) ?? []), rest]);
  }
  const lines = Object.values(rows.lines).map((line) => ({
    line,
    notes: (byLine.get(line.id) ?? []).toSorted((a, b) => a.start - b.start || a.id - b.id),
  }));
  return {
    bpm: rows.song.bpm,
    gap: rows.song.gap,
    singers: rows.singers.map((singer) => ({
      ...singer,
      lines: lines
        .filter(({ line }) => line.singerId === singer.id)
        .toSorted((a, b) => (a.notes[0]?.start ?? Infinity) - (b.notes[0]?.start ?? Infinity) || a.line.id - b.line.id)
        .map(({ line, notes }) => ({ id: line.id, switchStart: line.switchStart, switchEnd: line.switchEnd, notes })),
    })),
  };
}

/** Applies changes (forwards) to rows in place. */
export function applyToRows(rows: ChartRows, changes: readonly ChartChange[]) {
  for (const change of changes) {
    if (change.table === "song") Object.assign(rows.song, change.after);
    else if (change.table === "note") {
      if (change.after) rows.notes[change.id] = { ...change.after, id: change.id };
      else delete rows.notes[change.id];
    } else if (change.after) rows.lines[change.id] = { ...change.after, id: change.id };
    else delete rows.lines[change.id];
  }
}

/** What an edit is given to change the chart with. Reads see the edit's own changes so far. */
export interface EditRecorder {
  note(id: number): (NoteFields & { id: number }) | undefined;
  line(id: number): (LineFields & { id: number }) | undefined;
  /** Changes a note; it counts as changed by hand (`edited`) unless the patch says otherwise. */
  updateNote(id: number, patch: Partial<NoteFields>): void;
  updateLine(id: number, patch: Partial<LineFields>): void;
  /** A new note (changed by hand) or line; returns its id. */
  createNote(fields: Omit<NoteFields, "edited">): number;
  createLine(fields: LineFields): number;
  deleteNote(id: number): void;
  /** Deletes a line; its notes have to be deleted or moved first. */
  deleteLine(id: number): void;
  updateSong(patch: SongFields): void;
}

const noteFields = ({ id: _id, ...fields }: NoteFields & { id: number }): NoteFields => fields;
const lineFields = ({ id: _id, ...fields }: LineFields & { id: number }): LineFields => fields;

/** Whether two rows have the same fields with the same values, in whatever key order. */
function same(a: object, b: object): boolean {
  const left = a as Record<string, unknown>;
  const right = b as Record<string, unknown>;
  const keys = new Set([...Object.keys(left), ...Object.keys(right)]);
  return [...keys].every((key) => JSON.stringify(left[key]) === JSON.stringify(right[key]));
}

export function createChartDocument<Selection>(options: {
  chart: EditorChart;
  /** Saves one edit's changes (or their undo); rejects when the project couldn't take them. */
  save: (changes: ChartChange[]) => Promise<void>;
  /** Saving failed: say why and reload the chart from the project. */
  onFailed: (error: unknown) => void;
  selection: () => Selection;
  setSelection: (selection: Selection) => void;
}) {
  const initial = rowsFromChart(options.chart);
  const [rows, setRows] = createStore<ChartRows>(initial);
  const chart = createMemo(() => chartFromRows(rows));
  const history = createHistory<Selection>();
  /** Bumped on every step, so undo and redo labels update. */
  const [version, setVersion] = createSignal(0);
  /** New rows get ids above every existing one, never reused within the session. */
  let nextId =
    Math.max(
      0,
      ...Object.keys(initial.notes).map(Number),
      ...Object.keys(initial.lines).map(Number),
      ...initial.singers.map((singer) => singer.id),
    ) + 1;
  let saving = Promise.resolve();
  let failed = false;

  const commit = (changes: ChartChange[]) => {
    setRows((draft) => {
      applyToRows(draft, changes);
    });
    // Written now, not at the next microtask: an edit right after this one (undo, then an edit) reads these rows.
    flush();
    saving = saving.then(async () => {
      if (failed) return;
      try {
        await options.save(changes);
      } catch (error) {
        failed = true;
        history.clear();
        setVersion((v) => v + 1);
        options.onFailed(error);
      }
    });
  };

  /** Records an edit: what `build` changes, as one undoable step. Returns false when it changed nothing. */
  const edit = (
    label: string,
    build: (tx: EditRecorder) => void,
    edit: { merge?: string; selection?: Selection } = {},
  ): boolean => {
    if (failed) return false;
    const notes = new Map<number, (NoteFields & { id: number }) | null>();
    const lines = new Map<number, (LineFields & { id: number }) | null>();
    const changes: ChartChange[] = [];
    let songBefore: SongFields | null = null;
    let songAfter: SongFields = {};
    const currentNote = (id: number) => (notes.has(id) ? (notes.get(id) ?? undefined) : rows.notes[id]);
    const currentLine = (id: number) => (lines.has(id) ? (lines.get(id) ?? undefined) : rows.lines[id]);
    const recorder: EditRecorder = {
      note: (id) => {
        const row = currentNote(id);
        return row && { ...row };
      },
      line: (id) => {
        const row = currentLine(id);
        return row && { ...row };
      },
      updateNote: (id, patch) => {
        const row = currentNote(id);
        if (!row) throw new Error(`No note ${id}`);
        const next: NoteFields & { id: number } = { ...noteFields(row), edited: true, ...patch, id };
        if (same(next, row)) return;
        changes.push({ table: "note", id, before: noteFields(row), after: noteFields(next) });
        notes.set(id, next);
      },
      updateLine: (id, patch) => {
        const row = currentLine(id);
        if (!row) throw new Error(`No line ${id}`);
        const next: LineFields & { id: number } = { ...lineFields(row), ...patch, id };
        if (same(next, row)) return;
        changes.push({ table: "line", id, before: lineFields(row), after: lineFields(next) });
        lines.set(id, next);
      },
      createNote: (fields) => {
        const id = nextId++;
        const row = { ...fields, edited: true };
        changes.push({ table: "note", id, before: null, after: row });
        notes.set(id, { ...row, id });
        return id;
      },
      createLine: (fields) => {
        const id = nextId++;
        changes.push({ table: "line", id, before: null, after: { ...fields } });
        lines.set(id, { ...fields, id });
        return id;
      },
      deleteNote: (id) => {
        const row = currentNote(id);
        if (!row) return;
        changes.push({ table: "note", id, before: noteFields(row), after: null });
        notes.set(id, null);
      },
      deleteLine: (id) => {
        const row = currentLine(id);
        if (!row) return;
        changes.push({ table: "line", id, before: lineFields(row), after: null });
        lines.set(id, null);
      },
      updateSong: (patch) => {
        const current = { ...rows.song, ...songAfter } as Record<string, unknown>;
        songBefore ??= {};
        for (const key of Object.keys(patch)) {
          if (!(key in songBefore)) (songBefore as Record<string, unknown>)[key] = current[key] ?? null;
        }
        songAfter = { ...songAfter, ...patch };
      },
    };
    const before = options.selection();
    build(recorder);
    if (songBefore && !same(songBefore, songAfter))
      changes.push({ table: "song", before: songBefore, after: songAfter });
    if (changes.length === 0) return false;
    commit(changes);
    const after = edit.selection ?? before;
    if (edit.selection !== undefined) options.setSelection(edit.selection);
    history.push({ label, changes, selection: { before, after }, merge: edit.merge, at: Date.now() });
    setVersion((v) => v + 1);
    return true;
  };

  return {
    /** The chart as drawn; follows every edit. */
    chart,
    rows,
    edit,
    undo: () => {
      const step = failed ? undefined : history.undo();
      if (!step) return;
      commit(invert(step.changes));
      options.setSelection(step.selection.before);
      setVersion((v) => v + 1);
    },
    redo: () => {
      const step = failed ? undefined : history.redo();
      if (!step) return;
      commit(step.changes);
      options.setSelection(step.selection.after);
      setVersion((v) => v + 1);
    },
    /** What undo and redo would do ("Move 3 notes"), or null. */
    undoLabel: () => (version(), history.undoLabel()),
    redoLabel: () => (version(), history.redoLabel()),
    /** Resolves once everything edited so far is saved (or saving failed). */
    saved: () => saving,
  };
}

export type ChartDocument<Selection> = ReturnType<typeof createChartDocument<Selection>>;

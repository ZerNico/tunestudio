/**
 * Undo and redo for the editor, for every kind of edit: an edit is a transaction of row changes (each row as it was
 * and as it becomes, `ChartChange`), so undoing applies them backwards with before and after swapped. Nothing here
 * knows about notes or lines in particular, about Solid or about saving.
 */
import type { ChartChange } from "~/lib/native/contract";

/** One step of the history. */
export interface Transaction<Selection> {
  /** What it did, for "Undo Move 3 notes". */
  label: string;
  changes: ChartChange[];
  /** The selection to restore on undo and redo. */
  selection: { before: Selection; after: Selection };
  /** Steps with the same key close together merge into one (holding an arrow key nudges once, as far as undo knows). */
  merge?: string;
  /** When it was made (ms), for merging. */
  at: number;
}

/** The changes that undo `changes`: backwards, with before and after swapped. */
export function invert(changes: readonly ChartChange[]): ChartChange[] {
  return changes
    .toReversed()
    .map((change) => Object.assign({}, change, { before: change.after, after: change.before }) as ChartChange);
}

const rowKey = (change: ChartChange) => (change.table === "song" ? "song" : `${change.table}:${change.id}`);

/**
 * Two steps' changes as one: each row keeps its first `before` and last `after`, in the order rows first changed; a
 * row that ends as it began drops out. Song details merge field by field.
 */
export function mergeChanges(first: readonly ChartChange[], then: readonly ChartChange[]): ChartChange[] {
  const merged = new Map<string, ChartChange>();
  for (const change of [...first, ...then]) {
    const key = rowKey(change);
    const earlier = merged.get(key);
    if (!earlier) merged.set(key, change);
    else if (change.table === "song" && earlier.table === "song") {
      merged.set(key, {
        table: "song",
        before: { ...change.before, ...earlier.before },
        after: { ...earlier.after, ...change.after },
      });
    } else merged.set(key, { ...earlier, after: change.after } as ChartChange);
  }
  return [...merged.values()].filter((change) => !sameRow(change.before, change.after));
}

/** Whether a row ends as it began (fields compared in whatever key order). */
function sameRow(a: object | null, b: object | null): boolean {
  if (a === null || b === null) return a === b;
  const left = a as Record<string, unknown>;
  const right = b as Record<string, unknown>;
  const keys = new Set([...Object.keys(left), ...Object.keys(right)]);
  return [...keys].every((key) => JSON.stringify(left[key]) === JSON.stringify(right[key]));
}

/** How close together two steps with the same merge key have to be to become one. */
const MERGE_WITHIN_MS = 1000;

/** The undo and redo stacks. `limit` steps are kept; the oldest go first. */
export function createHistory<Selection>(limit = 500) {
  let past: Transaction<Selection>[] = [];
  let future: Transaction<Selection>[] = [];
  return {
    /** Records a step (dropping what could be redone); merges it into the last one when they share a merge key. */
    push(step: Transaction<Selection>) {
      future = [];
      const last = past.at(-1);
      if (last && step.merge && last.merge === step.merge && step.at - last.at < MERGE_WITHIN_MS) {
        const changes = mergeChanges(last.changes, step.changes);
        past = past.slice(0, -1);
        if (changes.length === 0) return;
        past.push({ ...step, changes, selection: { before: last.selection.before, after: step.selection.after } });
        return;
      }
      past.push(step);
      if (past.length > limit) past = past.slice(past.length - limit);
    },
    /** The step to undo (moved to the redo stack); its changes still need inverting to apply. */
    undo(): Transaction<Selection> | undefined {
      const step = past.pop();
      if (step) future.push(step);
      return step;
    },
    /** The step to redo (moved back to the undo stack). */
    redo(): Transaction<Selection> | undefined {
      const step = future.pop();
      if (step) past.push(step);
      return step;
    },
    clear() {
      past = [];
      future = [];
    },
    /** What undo and redo would do, or null. */
    undoLabel: () => past.at(-1)?.label ?? null,
    redoLabel: () => future.at(-1)?.label ?? null,
  };
}

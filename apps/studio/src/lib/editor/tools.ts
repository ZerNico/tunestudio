/**
 * The editor's tools, Premiere's way: V selects, D draws notes, C splits them. Tapping a tool's key switches to it;
 * holding it switches only while it is held (hold C, cut, let go: back to what it was). Esc goes back to Select.
 */
import { createSignal } from "solid-js";

export type Tool = "select" | "draw" | "split";

export const TOOLS: { tool: Tool; label: string; key: string }[] = [
  { tool: "select", label: "Select", key: "V" },
  { tool: "draw", label: "Draw", key: "D" },
  { tool: "split", label: "Split", key: "C" },
];

/** Holding a tool's key at least this long makes the switch last only while it is held (ms). */
const HOLD_MS = 300;

export function createTools(now: () => number = () => performance.now()) {
  const [tool, setTool] = createSignal<Tool>("select");
  /** The tool key held down, with the tool from before it and when it went down. */
  let held: { key: string; previous: Tool; at: number } | null = null;

  return {
    tool,
    setTool,
    /** A key went down: switches for a tool's key (returns whether it was one). */
    keyDown(event: { key: string; repeat: boolean }): boolean {
      const key = event.key.toLowerCase();
      const next = TOOLS.find((entry) => entry.key.toLowerCase() === key)?.tool;
      if (!next) return false;
      if (!event.repeat) {
        held = { key, previous: tool(), at: now() };
        setTool(next);
      }
      return true;
    },
    /** A key came up: after a hold, back to the tool from before. */
    keyUp(event: { key: string }) {
      if (!held || held.key !== event.key.toLowerCase()) return;
      if (now() - held.at >= HOLD_MS) setTool(held.previous);
      held = null;
    },
  };
}

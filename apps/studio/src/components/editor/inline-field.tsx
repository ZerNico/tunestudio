/**
 * A text field typed in place over the editor (a note's syllable, a line's lyrics), selected when it opens. Enter or
 * Tab keeps the text, Esc drops it (`null`), and leaving the field keeps it too; callers place it.
 */
import type { JSX } from "@solidjs/web";

/** How the field was left: Enter, Tab (Shift+Tab), or by focus going elsewhere. */
export type FieldExit = "enter" | "tab" | "shift-tab" | "blur";

export function InlineField(props: {
  value: string;
  label: string;
  /** Position and size (it is `absolute`). */
  style: JSX.CSSProperties;
  class?: string;
  /** Whether Tab leaves it (to go on to the next one), rather than moving focus. */
  tabs?: boolean;
  onDone: (text: string | null, exit: FieldExit) => void;
  testid: string;
  "data-row"?: string;
}) {
  return (
    <input
      ref={(input) => queueMicrotask(() => input.select())}
      class={`absolute z-40 rounded-[3px] border border-ring bg-field px-1 font-sans text-[12px] text-foreground outline-none ${props.class ?? ""}`}
      style={props.style}
      value={props.value}
      aria-label={props.label}
      spellcheck={false}
      data-row={props["data-row"]}
      onKeyDown={(event) => {
        const text = event.currentTarget.value;
        if (event.key === "Enter") props.onDone(text, "enter");
        else if (event.key === "Escape") props.onDone(null, "enter");
        else if (event.key === "Tab" && props.tabs) props.onDone(text, event.shiftKey ? "shift-tab" : "tab");
        else return;
        event.preventDefault();
        event.stopPropagation();
      }}
      onBlur={(event) => props.onDone(event.currentTarget.value, "blur")}
      data-testid={props.testid}
    />
  );
}

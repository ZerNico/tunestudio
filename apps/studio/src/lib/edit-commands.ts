/**
 * Undo, Redo, Cut, Copy and Paste for the whole app: in a text field they act on the text, as everywhere; elsewhere
 * they go to whatever registered a handler (the editor). They come from the Edit menu on macOS (its keys never reach
 * the page there) and from the page's own keys and clipboard events on Windows and Linux, which have no menu bar.
 */
import type { EditCommand } from "./native/channel";

export interface EditHandler {
  undo: () => void;
  redo: () => void;
  /**
   * Copies (or cuts) what is selected; returns the text for the system clipboard, null for nothing to copy (the
   * native copy goes on), or false for "handled, nothing to put there".
   */
  copy?: () => string | null | false;
  cut?: () => string | null | false;
  /** Pastes; `text` is the system clipboard's. Returns whether it pasted. */
  paste?: (text: string | undefined) => boolean;
}

let handler: EditHandler | null = null;

/** Makes `next` receive Undo and Redo; returns a function that stops it. */
export function setEditHandler(next: EditHandler): () => void {
  handler = next;
  return () => {
    if (handler === next) handler = null;
  };
}

/** A field, text area or editable element has the keyboard, or a dialog is open: keys belong to it. */
export function isTyping(target: EventTarget | null): boolean {
  return (
    target instanceof HTMLElement &&
    (target.isContentEditable ||
      ["INPUT", "TEXTAREA", "SELECT"].includes(target.tagName) ||
      !!target.closest("[role=dialog]"))
  );
}

/** Runs an Edit menu command (`text`: the system clipboard's, for Paste). */
export function runEditCommand(command: EditCommand, text?: string) {
  const editor = handler && !isTyping(document.activeElement) ? handler : null;
  if (command === "undo" || command === "redo") {
    if (editor) editor[command]();
    // oxlint-disable-next-line typescript/no-deprecated -- the only way to undo typing in a field from a menu
    else document.execCommand(command);
    return;
  }
  if (command === "paste") {
    if (!editor?.paste?.(text)) window.tunestudio?.clipboard?.({ native: "paste" });
    return;
  }
  const copied = editor?.[command]?.() ?? null;
  if (copied === false) return;
  window.tunestudio?.clipboard?.(copied === null ? { native: command } : { write: copied });
}

/** Pastes from the page itself (the note menu): main sends Paste back with the system clipboard's text. */
export function pasteFromClipboard() {
  window.tunestudio?.clipboard?.({ send: "paste" });
}

/** Listens for the Edit menu's Undo and Redo; returns a function that stops listening. */
export function listenForEditCommands(): () => void {
  return window.tunestudio?.onEditCommand?.(runEditCommand) ?? (() => {});
}

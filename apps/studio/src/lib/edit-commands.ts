/**
 * Undo and Redo for the whole app: in a text field they undo the typing, as everywhere; elsewhere they go to whatever
 * registered a handler (the editor). They come from the Edit menu on macOS (Cmd+Z never reaches the page there) and
 * from the editor's own keys on Windows and Linux, which have no menu bar.
 */
import type { EditCommand } from "./native/channel";

export interface EditHandler {
  undo: () => void;
  redo: () => void;
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

export function runEditCommand(command: EditCommand) {
  if (handler && !isTyping(document.activeElement)) handler[command]();
  // oxlint-disable-next-line typescript/no-deprecated -- the only way to undo typing in a field from a menu
  else document.execCommand(command);
}

/** Listens for the Edit menu's Undo and Redo; returns a function that stops listening. */
export function listenForEditCommands(): () => void {
  return window.tunestudio?.onEditCommand?.(runEditCommand) ?? (() => {});
}

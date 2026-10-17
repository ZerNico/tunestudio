/**
 * Key hints: holding Cmd (Ctrl off macOS) on its own for a moment shows every button's key beside it (`KeyHint`), so
 * the keys are found without opening the help. Anything else (another key, a click, a scroll, leaving the window) hides
 * them, so Cmd-click and Cmd-scroll never flash them. Not while typing in a field or with a dialog open: the keys don't
 * work there.
 */
import { createSignal } from "solid-js";

import { platform } from "~/lib/desktop";
import { isTyping } from "~/lib/edit-commands";

/** How long the modifier is held before the hints show (ms). */
export const HINT_DELAY_MS = 250;

/** Whether the key hints show. */
const [keyHintsShown, setShown] = createSignal(false);
export { keyHintsShown };

/** Listens on `target` for the modifier held on its own; returns a function that stops listening. */
export function listenForKeyHints(target: Window = window, modifier = platform === "macos" ? "Meta" : "Control") {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const hide = () => {
    clearTimeout(timer);
    timer = undefined;
    setShown(false);
  };
  const down = (event: KeyboardEvent) => {
    if (event.repeat) return;
    hide();
    if (event.key !== modifier || event.shiftKey || event.altKey) return;
    // Typing in a field, or in a dialog (which holds the focus); toasts don't count.
    if (isTyping(document.activeElement)) return;
    timer = setTimeout(() => setShown(true), HINT_DELAY_MS);
  };
  // The window losing focus, not an element in it (blur doesn't bubble, but capturing sees every element's).
  const blur = (event: Event) => {
    if (event.target === target) hide();
  };
  const events = ["keyup", "pointerdown", "wheel"] as const;
  target.addEventListener("keydown", down, true);
  target.addEventListener("blur", blur, true);
  for (const name of events) target.addEventListener(name, hide, true);
  return () => {
    hide();
    target.removeEventListener("keydown", down, true);
    target.removeEventListener("blur", blur, true);
    for (const name of events) target.removeEventListener(name, hide, true);
  };
}

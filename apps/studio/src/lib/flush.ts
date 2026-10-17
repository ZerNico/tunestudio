/**
 * Saving what is still waiting when main asks: before the window closes, the app quits or the page reloads. Whoever
 * has unsaved work (the editor) says how with `setFlushHandler`; main waits for it, a few seconds at most
 * (`electron/flush.ts`).
 */

type FlushHandler = () => Promise<void>;

/** What the preload provides for this (see `electron/preload.ts`). */
interface FlushGlobals {
  onFlushRequest?: (handler: FlushHandler) => () => void;
}

// Missing when the renderer runs in a plain browser (`bun run dev:vite`).
const globals = window.tunestudio as FlushGlobals | undefined;

/** Makes `handler` run when main asks to save before closing; returns a function that stops it. */
export function setFlushHandler(handler: FlushHandler): () => void {
  return globals?.onFlushRequest?.(handler) ?? (() => {});
}

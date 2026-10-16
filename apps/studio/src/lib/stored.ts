/**
 * A setting kept in localStorage: read once (missing or unreadable: its default), written whenever it is set. For
 * small UI choices that outlive the window (the home screen's view, the editor's listening settings).
 */
import { createMemo, createSignal } from "solid-js";

export interface StoredFormat<T> {
  /** The value in `text`, or undefined when it isn't one. */
  read: (text: string) => T | undefined;
  write: (value: T) => string;
}

/** "on" / "off". */
export const onOff: StoredFormat<boolean> = {
  read: (text) => (text === "on" ? true : text === "off" ? false : undefined),
  write: (value) => (value ? "on" : "off"),
};

export function createStored<T>(key: string, format: StoredFormat<T>, fallback: T): [() => T, (value: T) => void] {
  const text = localStorage.getItem(key);
  // Boxed: a function given to a Solid 2 signal would be taken as its computation.
  const [box, setBox] = createSignal({ value: text === null ? fallback : (format.read(text) ?? fallback) });
  const set = (next: T) => {
    setBox({ value: next });
    localStorage.setItem(key, format.write(next));
  };
  const value = createMemo(() => box().value);
  return [value, set];
}

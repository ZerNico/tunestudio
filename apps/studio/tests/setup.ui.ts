import "@testing-library/jest-dom/vitest";
import { cleanup } from "@solidjs/testing-library";
import { afterEach } from "vitest";

// Without `globals: true`, the testing library can't register its own auto-cleanup, so
// renders would leak into the next test's queries.
afterEach(cleanup);

// jsdom has no PointerEvent, but Base UI dispatches and listens for them. MouseEvent is
// shape-compatible for everything the components read.
if (typeof globalThis.PointerEvent === "undefined") {
  globalThis.PointerEvent = class PointerEvent extends MouseEvent {} as never;
}

// jsdom lays nothing out and has no ResizeObserver; Base UI's floating parts observe sizes.
if (typeof globalThis.ResizeObserver === "undefined") {
  globalThis.ResizeObserver = class ResizeObserver {
    observe() {}
    unobserve() {}
    disconnect() {}
  };
}

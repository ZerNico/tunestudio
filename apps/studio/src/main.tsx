import { render } from "@solidjs/web";
import { createRouter, RouterProvider } from "@tanstack/solid-router";

import { native } from "~/lib/native/client";
import { routeTree } from "~/routeTree.gen";

import "./styles.css";

// Renderer warnings and errors also land in the log file.
for (const level of ["warn", "error"] as const) {
  const original = console[level].bind(console);
  console[level] = (...args: unknown[]) => {
    original(...args);
    const message = args.map((arg) => (arg instanceof Error ? (arg.stack ?? arg.message) : String(arg))).join(" ");
    void native.app.log({ level, message }).catch(() => {});
  };
}
window.addEventListener("unhandledrejection", (event) => console.error("Unhandled rejection:", event.reason));

const router = createRouter({
  routeTree,
  defaultPreload: false,
});

declare module "@tanstack/solid-router" {
  interface Register {
    router: typeof router;
  }
}

const rootElement = document.getElementById("app");
if (rootElement) render(() => <RouterProvider router={router} />, rootElement);

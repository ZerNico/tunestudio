import { Outlet } from "@tanstack/solid-router";
import { onSettled } from "solid-js";

import { Toaster } from "~/components/ui/toast";
import { TooltipProvider } from "~/components/ui/tooltip";

function blockContextMenu(event: MouseEvent) {
  const target = event.target;
  if (target instanceof HTMLInputElement || target instanceof HTMLTextAreaElement) return;
  event.preventDefault();
}

/** App shell around every route: tooltips, toasts and the release-build right-click policy. */
export default function RootScreen() {
  // Release builds have no browser context menu outside text fields; the app's own menus
  // (Base UI ContextMenu) call preventDefault themselves, so this only blocks the rest.
  if (import.meta.env.PROD) {
    onSettled(() => {
      window.addEventListener("contextmenu", blockContextMenu);
      return () => window.removeEventListener("contextmenu", blockContextMenu);
    });
  }

  return (
    <TooltipProvider>
      <Toaster>
        <Outlet />
      </Toaster>
    </TooltipProvider>
  );
}

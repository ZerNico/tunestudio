import { Outlet } from "@tanstack/solid-router";
import { onSettled } from "solid-js";

import { Toaster } from "~/components/ui/toast";
import { TooltipProvider } from "~/components/ui/tooltip";
import { platform } from "~/lib/desktop";
import { listenForEditCommands } from "~/lib/edit-commands";
import { native } from "~/lib/native/client";
import { announceUpdate } from "~/lib/updates";

function blockContextMenu(event: MouseEvent) {
  const target = event.target;
  if (target instanceof HTMLInputElement || target instanceof HTMLTextAreaElement) return;
  event.preventDefault();
}

/** The mouse's back and forward buttons (3, 4): Chromium would move through the screens with them. */
function blockHistoryButtons(event: MouseEvent) {
  if (event.button === 3 || event.button === 4) event.preventDefault();
}

/** Ctrl+Shift+N opens another window on Windows and Linux (macOS has it in the File menu). */
function newWindowKey(event: KeyboardEvent) {
  if (!event.ctrlKey || !event.shiftKey || event.altKey || event.metaKey || event.key.toLowerCase() !== "n") return;
  event.preventDefault();
  void native.windows.add();
}

/**
 * App shell around every route: tooltips, toasts, the Edit menu's Undo and Redo, a new window's key, the mouse's back
 * and forward buttons doing nothing, the release-build right-click policy, and a newer release's toast.
 */
export default function RootScreen() {
  onSettled(() => listenForEditCommands());
  onSettled(() => void announceUpdate());
  onSettled(() => {
    window.addEventListener("mouseup", blockHistoryButtons, true);
    window.addEventListener("mousedown", blockHistoryButtons, true);
    return () => {
      window.removeEventListener("mouseup", blockHistoryButtons, true);
      window.removeEventListener("mousedown", blockHistoryButtons, true);
    };
  });
  if (platform !== "macos") {
    onSettled(() => {
      window.addEventListener("keydown", newWindowKey);
      return () => window.removeEventListener("keydown", newWindowKey);
    });
  }
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

import { createFileRoute, redirect } from "@tanstack/solid-router";

import { toastError } from "~/components/ui/toast";
import { native } from "~/lib/native/client";
import { loadRecentProjects } from "~/lib/recent-projects";
import HomeScreen from "~/screens/index";

/**
 * The start screen, with the recent projects from main. A project file the OS handed this window (double-clicked in
 * Finder or Explorer, or given at launch) opens before it shows, so the start screen doesn't flash first; later ones
 * are the screen's (`takeOpenRequest` there).
 */
export const Route = createFileRoute("/")({
  loader: async ({ cause }) => {
    // Not when the screen loads its list again (`stay`): a request waiting for a new project's flow stays waiting.
    const path = cause === "enter" ? await native.windows.takeOpenRequest().catch(() => null) : null;
    if (path) {
      const opened = await native.project.open({ path }).catch((error: unknown) => {
        toastError("Couldn't open the project", error);
        return null;
      });
      // Open in another window, which came to the front instead: this one shows the start screen.
      if (opened && !opened.elsewhere) throw redirect({ to: "/project/$id", params: { id: opened.id } });
    }
    return loadRecentProjects();
  },
  component: HomeScreen,
});

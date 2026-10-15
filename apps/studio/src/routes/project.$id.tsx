import { createFileRoute, redirect } from "@tanstack/solid-router";

import { ProjectNotOpen } from "~/lib/errors";
import { native } from "~/lib/native/client";
import ProjectScreen from "~/screens/project.$id";

/**
 * An open project in the editor, by its session ID in main. The ID only lives while the project is open, so a
 * reload after closing it (or an old URL) goes back to the start screen.
 */
export const Route = createFileRoute("/project/$id")({
  loader: async ({ params }) => {
    try {
      const [overview, chart] = await Promise.all([
        native.project.overview({ id: params.id }),
        native.project.chart({ id: params.id }),
      ]);
      return { overview, chart };
    } catch (error) {
      if (error instanceof ProjectNotOpen) throw redirect({ to: "/" });
      throw error;
    }
  },
  component: ProjectScreen,
});

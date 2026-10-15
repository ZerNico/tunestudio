import { ORPCError } from "@orpc/client";
import { createFileRoute, redirect } from "@tanstack/solid-router";

import { native } from "~/lib/native/client";
import ProjectScreen from "~/screens/project.$id";

/**
 * An open project, by its session ID in main. The ID only lives while the project is open, so a
 * reload after closing it (or an old URL) goes back to the start screen.
 */
export const Route = createFileRoute("/project/$id")({
  loader: async ({ params }) => {
    try {
      return await native.project.overview({ id: params.id });
    } catch (error) {
      if (error instanceof ORPCError && error.data?.tag === "ProjectNotOpen") throw redirect({ to: "/" });
      throw error;
    }
  },
  component: ProjectScreen,
});

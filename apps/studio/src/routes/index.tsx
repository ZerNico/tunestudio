import { createFileRoute } from "@tanstack/solid-router";

import { loadRecentProjects } from "~/lib/recent-projects";
import HomeScreen from "~/screens/index";

/** The start screen, with the recent projects from main. */
export const Route = createFileRoute("/")({
  loader: () => loadRecentProjects(),
  component: HomeScreen,
});

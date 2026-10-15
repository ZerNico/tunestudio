import { platform } from "~/lib/desktop";
import { native } from "~/lib/native/client";
import type { RecentProjectEntry } from "~/lib/native/types";

import type { RecentProject } from "./types";

export { searchRecentProjects } from "./search";
export type { RecentProject } from "./types";

/** A stored entry as the start screen shows it. */
export function fromEntry(entry: RecentProjectEntry): RecentProject {
  return {
    id: entry.path,
    title: entry.title,
    artist: entry.artist,
    path: entry.path,
    lastOpened: entry.lastOpened,
    ...(entry.cover ? { coverUrl: entry.cover } : {}),
  };
}

/** The entry to hand back to main, e.g. to undo removing it. */
export function toEntry(project: RecentProject): RecentProjectEntry {
  return {
    path: project.path,
    title: project.title,
    artist: project.artist,
    lastOpened: project.lastOpened,
    ...(project.coverUrl ? { cover: project.coverUrl } : {}),
  };
}

/**
 * The recent projects from main, newest first. A plain browser (`bun run dev:vite`) has no
 * main process and no recents.
 */
export async function loadRecentProjects(): Promise<RecentProject[]> {
  if (platform === "browser") return [];
  return (await native.recents.list()).map(fromEntry);
}

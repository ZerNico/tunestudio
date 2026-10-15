import type { RecentProject } from "./types";

/**
 * The projects matching every word of `query` (case-insensitive) in their artist, title or
 * path, in their original order. A blank query matches everything.
 */
export function searchRecentProjects(projects: RecentProject[], query: string): RecentProject[] {
  const words = query.trim().toLowerCase().split(/\s+/).filter(Boolean);
  if (words.length === 0) return projects;
  return projects.filter((project) => {
    const haystack = `${project.artist} ${project.title} ${project.path}`.toLowerCase();
    return words.every((word) => haystack.includes(word));
  });
}

import { describe, expect, it } from "vitest";

import { searchRecentProjects } from "./search";
import type { RecentProject } from "./types";

const project = (id: string, artist: string, title: string, path: string): RecentProject => ({
  id,
  artist,
  title,
  path,
  lastOpened: "2026-10-14T12:00:00Z",
});

const projects = [
  project("a", "Raum27", "Oft gesagt", "~/Music/UltraStar/Raum27 - Oft gesagt"),
  project("b", "Queen", "Bohemian Rhapsody", "~/Charts/Queen - Bohemian Rhapsody"),
  project("c", "Queens of the Stone Age", "No One Knows", "/Volumes/Songs/QOTSA"),
];
const ids = (list: RecentProject[]) => list.map((item) => item.id);

describe("searchRecentProjects", () => {
  it("returns every project for a blank query", () => {
    expect(searchRecentProjects(projects, "")).toBe(projects);
    expect(searchRecentProjects(projects, "   ")).toBe(projects);
  });

  it("matches artist, title and path case-insensitively, keeping the order", () => {
    expect(ids(searchRecentProjects(projects, "QUEEN"))).toEqual(["b", "c"]);
    expect(ids(searchRecentProjects(projects, "rhapsody"))).toEqual(["b"]);
    expect(ids(searchRecentProjects(projects, "volumes"))).toEqual(["c"]);
  });

  it("requires every word, in any order and across fields", () => {
    expect(ids(searchRecentProjects(projects, "  knows   stone "))).toEqual(["c"]);
    expect(ids(searchRecentProjects(projects, "queen music"))).toEqual([]);
  });
});

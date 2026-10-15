import { render, screen, within } from "@solidjs/testing-library";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";

import type { RecentProject } from "~/lib/recent-projects";

import { RecentProjects } from "./recent-projects";

const project = (id: string, artist: string, title: string): RecentProject => ({
  id,
  artist,
  title,
  path: `~/Music/UltraStar/${artist} - ${title}`,
  lastOpened: new Date(Date.now() - 3 * 60 * 60 * 1000).toISOString(),
});

const projects = [project("raum27", "Raum27", "Oft gesagt"), project("queen", "Queen", "Bohemian Rhapsody")];

function setup(list: RecentProject[]) {
  const actions = { onOpen: vi.fn(), onReveal: vi.fn(), onRemove: vi.fn() };
  render(() => <RecentProjects projects={list} searchRef={() => {}} {...actions} />);
  return { actions, user: userEvent.setup() };
}

beforeEach(() => localStorage.clear());

describe("RecentProjects", () => {
  it("shows the first-launch note and no search or list without projects", () => {
    setup([]);
    expect(screen.getByRole("region", { name: "Recent projects" })).toBeInTheDocument();
    expect(screen.getByText("No recent projects yet")).toBeInTheDocument();
    expect(screen.queryByRole("searchbox")).not.toBeInTheDocument();
    expect(screen.queryByRole("list")).not.toBeInTheDocument();
  });

  it("shows header actions with and without projects", () => {
    render(() => (
      <RecentProjects
        projects={[]}
        searchRef={() => {}}
        onOpen={vi.fn()}
        onReveal={vi.fn()}
        onRemove={vi.fn()}
        headerActions={<button type="button">Open project…</button>}
      />
    ));
    expect(screen.getByRole("button", { name: "Open project…" })).toBeInTheDocument();
  });

  it("lists each project as a button describing it", () => {
    setup(projects);
    const list = screen.getByRole("list", { name: "Recent projects" });
    const items = within(list).getAllByRole("button");
    expect(items).toHaveLength(2);
    expect(items[0]).toHaveAccessibleName("Raum27, Oft gesagt. Opened 3 hours ago.");
  });

  it("tells projects of the same song apart by what their file name adds", () => {
    setup([
      { ...project("solo", "Queen", "Bohemian Rhapsody"), path: "/Music/Queen - Bohemian Rhapsody.tunestudio" },
      { ...project("duet", "Queen", "Bohemian Rhapsody"), path: "/Music/Queen - Bohemian Rhapsody (Duet).tunestudio" },
    ]);
    expect(screen.getAllByTestId("recent-title").map((title) => title.textContent)).toEqual([
      "Bohemian Rhapsody",
      "Bohemian Rhapsody (Duet)",
    ]);
    expect(screen.getAllByRole("button", { name: /Bohemian Rhapsody \(Duet\)\./ })).toHaveLength(1);
  });

  it("filters by search, says when nothing matches, and Escape clears it", async () => {
    const { user } = setup(projects);
    const search = screen.getByRole("searchbox", { name: "Search recent projects" });

    await user.type(search, "queen");
    expect(within(screen.getByRole("list")).getAllByRole("button")).toHaveLength(1);

    await user.type(search, " zzz");
    expect(screen.queryByRole("list")).not.toBeInTheDocument();
    expect(screen.getByText(/No projects match/)).toHaveTextContent("“queen zzz”");

    await user.keyboard("{Escape}");
    expect(search).toHaveValue("");
    expect(within(screen.getByRole("list")).getAllByRole("button")).toHaveLength(2);
  });

  it("opens a project with Enter and removes it with Delete", async () => {
    const { actions, user } = setup(projects);
    const [first] = within(screen.getByRole("list")).getAllByRole("button");

    first!.focus();
    await user.keyboard("{Enter}");
    expect(actions.onOpen).toHaveBeenCalledExactlyOnceWith(projects[0]);

    await user.keyboard("{Delete}");
    expect(actions.onRemove).toHaveBeenCalledExactlyOnceWith(projects[0]);
    expect(actions.onReveal).not.toHaveBeenCalled();
  });

  it("switches to the list layout and remembers it", async () => {
    const { user } = setup(projects);
    await user.click(screen.getByRole("button", { name: "List" }));
    expect(screen.getByRole("button", { name: "List" })).toHaveAttribute("aria-pressed", "true");
    expect(localStorage.getItem("tunestudio.home.recentView")).toBe("list");
  });
});

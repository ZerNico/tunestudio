import { render, screen, within } from "@solidjs/testing-library";
import userEvent from "@testing-library/user-event";
import { createSignal } from "solid-js";
import { describe, expect, it, vi } from "vitest";

import type { ChartVersion } from "~/lib/native/types";

import { type VersionActions, VersionsDialog } from "./versions-dialog";

const ago = (minutes: number) => new Date(Date.now() - minutes * 60_000).toISOString();

const kept: ChartVersion[] = [
  { id: 2, createdAt: ago(5), label: "Before Auto pitch", kind: "auto", notes: 212, lines: 31 },
  { id: 1, createdAt: ago(120), label: "First draft", kind: "named", notes: 1, lines: 1 },
];

function setup(initial: readonly ChartVersion[] = kept) {
  let versions = [...initial];
  const actions: VersionActions = {
    list: vi.fn(async () => versions),
    save: vi.fn(async (name: string) => {
      versions = [{ id: 3, createdAt: ago(0), label: name, kind: "named", notes: 212, lines: 31 }, ...versions];
    }),
    restore: vi.fn(async () => {}),
    rename: vi.fn(async (version: ChartVersion, name: string) => {
      versions = versions.map((item) => (item.id === version.id ? { ...item, label: name, kind: "named" } : item));
    }),
    remove: vi.fn(async (version: ChartVersion) => {
      versions = versions.filter((item) => item.id !== version.id);
    }),
    onError: vi.fn(),
  };
  const [open, setOpen] = createSignal(true);
  render(() => <VersionsDialog open={open()} onOpenChange={setOpen} actions={actions} />);
  return { actions, open, user: userEvent.setup() };
}

const rows = () => screen.queryAllByTestId("version");
const labels = () => rows().map((row) => row.querySelector("[data-kind]")!.textContent);

describe("versions dialog", () => {
  it("lists the versions with when they were kept and what they hold", async () => {
    setup();
    await vi.waitFor(() => expect(rows()).toHaveLength(2));
    expect(labels()).toEqual(["Before Auto pitch", "First draft"]);
    expect(rows()[0]).toHaveTextContent("5 minutes ago · 212 notes, 31 lines");
    expect(rows()[1]).toHaveTextContent("2 hours ago · 1 note, 1 line");
  });

  it("says when there are none yet", async () => {
    setup([]);
    expect(await screen.findByTestId("no-versions")).toHaveTextContent("No versions yet");
  });

  it("saves the chart as a named version", async () => {
    const { actions, user } = setup();
    const save = screen.getByRole("button", { name: "Save version" });
    expect(save).toBeDisabled();
    await user.type(screen.getByRole("textbox", { name: "New version's name" }), "  Before the duet  ");
    await user.click(save);
    expect(actions.save).toHaveBeenCalledWith("Before the duet");
    await vi.waitFor(() => expect(labels()[0]).toBe("Before the duet"));
    expect(screen.getByRole("textbox", { name: "New version's name" })).toHaveValue("");
  });

  it("restores a version and closes", async () => {
    const { actions, open, user } = setup();
    await vi.waitFor(() => expect(rows()).toHaveLength(2));
    await user.click(within(rows()[1]!).getByRole("button", { name: "Restore" }));
    expect(actions.restore).toHaveBeenCalledWith(kept[1]);
    await vi.waitFor(() => expect(open()).toBe(false));
  });

  it("names an automatic version to keep it, and deletes one", async () => {
    const { actions, user } = setup();
    await vi.waitFor(() => expect(rows()).toHaveLength(2));
    await user.click(screen.getByRole("button", { name: "More for “Before Auto pitch”" }));
    await user.click(await screen.findByRole("menuitem", { name: "Name and keep" }));
    const field = await screen.findByRole("textbox", { name: "Version name" });
    await user.clear(field);
    await user.type(field, "Good pitches{Enter}");
    expect(actions.rename).toHaveBeenCalledWith(kept[0], "Good pitches");
    await vi.waitFor(() => expect(labels()[0]).toBe("Good pitches"));

    await user.click(screen.getByRole("button", { name: "More for “First draft”" }));
    await user.click(await screen.findByRole("menuitem", { name: "Delete" }));
    expect(actions.remove).toHaveBeenCalledWith(kept[1]);
    await vi.waitFor(() => expect(labels()).toEqual(["Good pitches"]));
  });

  it("keeps an automatic version named as it was when the name isn't changed", async () => {
    const { actions, user } = setup();
    await vi.waitFor(() => expect(rows()).toHaveLength(2));
    await user.click(screen.getByRole("button", { name: "More for “Before Auto pitch”" }));
    await user.click(await screen.findByRole("menuitem", { name: "Name and keep" }));
    await user.type(await screen.findByRole("textbox", { name: "Version name" }), "{Enter}");
    expect(actions.rename).toHaveBeenCalledWith(kept[0], "Before Auto pitch");
    await vi.waitFor(() => expect(rows()[0]!.querySelector("[data-kind]")).toHaveAttribute("data-kind", "named"));
  });

  it("leaves the name as it was when Esc is pressed", async () => {
    const { actions, open, user } = setup();
    await vi.waitFor(() => expect(rows()).toHaveLength(2));
    await user.click(screen.getByRole("button", { name: "More for “First draft”" }));
    await user.click(await screen.findByRole("menuitem", { name: "Rename" }));
    await user.type(await screen.findByRole("textbox", { name: "Version name" }), "Other{Escape}");
    expect(actions.rename).not.toHaveBeenCalled();
    expect(labels()).toEqual(["Before Auto pitch", "First draft"]);
    expect(open()).toBe(true);
  });
});

import { render, screen, waitFor } from "@solidjs/testing-library";
import userEvent from "@testing-library/user-event";
import { createSignal } from "solid-js";
import { describe, expect, it, vi } from "vitest";

import { testNote } from "~/lib/editor/test-chart";
import type { EditorSinger } from "~/lib/native/types";

import { SingerSwitch } from "./singer-switch";

const anna: EditorSinger = {
  id: 1,
  index: 1,
  name: "Anna",
  lines: [{ id: 10, switchStart: null, switchEnd: null, notes: [testNote(100, 1), testNote(101, 2)] }],
};
const p2: EditorSinger = { id: 2, index: 2, name: null, lines: [] };

function setup(initial: EditorSinger[]) {
  const [singers, setSingers] = createSignal(initial);
  const [hidden, setHidden] = createSignal<number[]>([]);
  const calls = {
    choose: vi.fn(),
    hide: vi.fn((index: number, hide: boolean) => setHidden(hide ? [index] : [])),
    solo: vi.fn(),
    add: vi.fn(() => {
      setSingers((current) => [...current, p2]);
      return 2;
    }),
    rename: vi.fn(),
    remove: vi.fn(),
  };
  render(() => (
    <SingerSwitch
      singers={singers()}
      active={1}
      isHidden={(index) => hidden().includes(index)}
      busy={false}
      onChoose={calls.choose}
      onHidden={calls.hide}
      onSolo={calls.solo}
      onShowAll={() => setHidden([])}
      onAdd={calls.add}
      onRename={calls.rename}
      onRemove={calls.remove}
    />
  ));
  return { calls, setSingers };
}

describe("singer switch", () => {
  it("adds a second singer to a solo chart and names it right away", async () => {
    const { calls } = setup([anna]);
    const user = userEvent.setup();
    await user.click(screen.getByRole("button", { name: "Add singer" }));
    expect(calls.add).toHaveBeenCalledOnce();
    const name = await screen.findByRole("textbox", { name: "Name of P2" });
    await waitFor(() => expect(name).toHaveFocus());
    await user.type(name, "Ben{Enter}");
    expect(calls.rename).toHaveBeenCalledWith(2, "Ben");
    expect(screen.queryByRole("textbox")).toBeNull();
  });

  it("chooses a singer, hides one, and renames with a double-click (Esc keeps the name)", async () => {
    const { calls } = setup([anna, p2]);
    const user = userEvent.setup();
    expect(screen.getByRole("button", { name: "Anna, P1" })).toHaveAttribute("aria-pressed", "true");
    await user.click(screen.getByRole("button", { name: "P2, P2" }));
    expect(calls.choose).toHaveBeenCalledWith(2);
    await user.click(screen.getByRole("button", { name: "Hide P2" }));
    expect(calls.hide).toHaveBeenCalledWith(2, true);
    expect(await screen.findByRole("button", { name: "Show P2" })).toBeVisible();

    await user.dblClick(screen.getByRole("button", { name: "Anna, P1" }));
    await user.type(await screen.findByRole("textbox", { name: "Name of P1" }), "Mia{Escape}");
    expect(calls.rename).not.toHaveBeenCalled();
    // Clearing the name falls back to P1.
    await user.dblClick(screen.getByRole("button", { name: "Anna, P1" }));
    const name = await screen.findByRole("textbox", { name: "Name of P1" });
    await user.clear(name);
    await user.type(name, "{Enter}");
    expect(calls.rename).toHaveBeenCalledWith(1, null);
  });

  it("shows only one singer, or both again, from a chip's context menu", async () => {
    const { calls } = setup([anna, p2]);
    const user = userEvent.setup();
    await user.pointer({ keys: "[MouseRight]", target: screen.getByRole("button", { name: "P2, P2" }) });
    await user.click(await screen.findByRole("menuitem", { name: "Show only P2" }));
    expect(calls.solo).toHaveBeenCalledWith(2);
    await user.pointer({ keys: "[MouseRight]", target: screen.getByRole("button", { name: "Anna, P1" }) });
    await user.click(await screen.findByRole("menuitem", { name: "Rename" }));
    expect(await screen.findByRole("textbox", { name: "Name of P1" })).toBeVisible();
  });

  it("asks what to do with a removed singer's notes, and removes an empty one at once", async () => {
    const { calls } = setup([anna, p2]);
    const user = userEvent.setup();
    await user.pointer({ keys: "[MouseRight]", target: screen.getByRole("button", { name: "Anna, P1" }) });
    await user.click(await screen.findByRole("menuitem", { name: "Remove Anna" }));
    expect(await screen.findByRole("heading", { name: "Remove Anna?" })).toBeVisible();
    expect(screen.getByText("Anna has 2 notes.")).toBeVisible();
    await user.click(screen.getByRole("button", { name: "Move them to P2" }));
    expect(calls.remove).toHaveBeenCalledWith(1, true);

    await user.pointer({ keys: "[MouseRight]", target: screen.getByRole("button", { name: "P2, P2" }) });
    await user.click(await screen.findByRole("menuitem", { name: "Remove P2" }));
    expect(calls.remove).toHaveBeenLastCalledWith(2, false);
  });
});

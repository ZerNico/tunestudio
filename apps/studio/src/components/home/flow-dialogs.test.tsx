import { render, screen } from "@solidjs/testing-library";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";

import type { ToolProgress, ToolStatus } from "~/lib/native/types";

import { FlowDialog } from "./flow-dialogs";

// The main process isn't there in jsdom: its client is the one thing replaced.
const native = vi.hoisted(() => ({
  tools: { prepare: vi.fn() },
  youtube: { inspect: vi.fn() },
  settings: { get: vi.fn() },
}));
vi.mock("~/lib/native/client", () => ({ native }));
vi.mock("~/lib/native/effect-client", () => ({ effectNative: native }));

/** Tools that are prepared once `gate` resolves. */
async function* tools(gate: Promise<void>): AsyncGenerator<ToolProgress, ToolStatus[]> {
  yield { tool: "yt-dlp", phase: "checking" };
  await gate;
  return [];
}

function setup(gate: Promise<void> = Promise.resolve()) {
  native.tools.prepare.mockReset().mockResolvedValue(tools(gate));
  native.youtube.inspect.mockReset().mockReturnValue(new Promise(() => {}));
  native.settings.get.mockReset().mockReturnValue(new Promise(() => {}));
  const onClose = vi.fn();
  render(() => (
    <FlowDialog
      flow={{ kind: "youtube", url: "https://youtu.be/dQw4w9WgXcQ", videoId: "dQw4w9WgXcQ" }}
      onClose={onClose}
      onOpened={() => {}}
    />
  ));
  return { onClose, user: userEvent.setup() };
}

describe("FlowDialog", () => {
  it("doesn't close a new YouTube project from a click outside", async () => {
    const { onClose, user } = setup();
    await screen.findByRole("dialog", { name: "New project from YouTube" });
    await user.click(document.body);
    expect(onClose).not.toHaveBeenCalled();
    expect(screen.queryByRole("dialog", { name: "Discard this new project?" })).toBeNull();
  });

  it("asks before Escape or Cancel discard it, and Keep working keeps it", async () => {
    const { onClose, user } = setup();
    await screen.findByRole("dialog", { name: "New project from YouTube" });

    await user.keyboard("{Escape}");
    await screen.findByRole("dialog", { name: "Discard this new project?" });
    await user.click(screen.getByRole("button", { name: "Keep working" }));
    expect(onClose).not.toHaveBeenCalled();

    await user.click(screen.getByRole("button", { name: "Cancel" }));
    await screen.findByRole("dialog", { name: "Discard this new project?" });
    await user.click(screen.getByRole("button", { name: "Discard" }));
    expect(onClose).toHaveBeenCalledOnce();
  });
});

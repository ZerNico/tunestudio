import { ORPCError } from "@orpc/client";
import { render, screen } from "@solidjs/testing-library";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";

import type { ToolProgress, ToolStatus } from "~/lib/native/types";

import { ToolsStep } from "./tools-step";

// The main process isn't there in jsdom: its client is the one thing replaced.
const native = vi.hoisted(() => ({ tools: { prepare: vi.fn() } }));
vi.mock("~/lib/native/client", () => ({ native }));
vi.mock("~/lib/native/effect-client", () => ({ effectNative: native }));

/** Yields `steps`, waiting for `gate` before finishing, so a test can look at the progress. */
async function* progress(steps: ToolProgress[], gate: Promise<void>): AsyncGenerator<ToolProgress, ToolStatus[]> {
  for (const step of steps) yield step;
  await gate;
  return [];
}

beforeEach(() => native.tools.prepare.mockReset());

describe("ToolsStep", () => {
  it("shows download progress until the tools are ready", async () => {
    let open!: () => void;
    const gate = new Promise<void>((resolve) => (open = resolve));
    native.tools.prepare.mockResolvedValue(
      progress([{ tool: "ffmpeg", phase: "downloading", received: 15 * 1024 * 1024, total: 60 * 1024 * 1024 }], gate),
    );
    const onReady = vi.fn();
    render(() => <ToolsStep onReady={onReady} />);

    expect(await screen.findByText("Downloading FFmpeg… 15 MB of 60 MB")).toBeInTheDocument();
    expect(screen.getByRole("progressbar", { name: "Download tools progress" })).toHaveValue(25);
    open();
    await vi.waitFor(() => expect(onReady).toHaveBeenCalledOnce());
    expect(screen.queryByTestId("tools-progress")).toBeNull();
    expect(native.tools.prepare).toHaveBeenCalledWith({ tools: ["yt-dlp", "quickjs", "ffmpeg"] }, expect.anything());
  });

  it("explains a failure and tries again", async () => {
    native.tools.prepare.mockRejectedValueOnce(
      new ORPCError("BAD_REQUEST", { message: "Couldn't check for yt-dlp: No connection." }),
    );
    native.tools.prepare.mockResolvedValueOnce(progress([], Promise.resolve()));
    const onReady = vi.fn();
    render(() => <ToolsStep onReady={onReady} />);

    expect(await screen.findByRole("alert")).toHaveTextContent("Couldn't check for yt-dlp: No connection.");
    await userEvent.setup().click(screen.getByRole("button", { name: "Try again" }));
    await vi.waitFor(() => expect(onReady).toHaveBeenCalledOnce());
  });

  it("stays out of sight while a quick update check runs", async () => {
    vi.useFakeTimers();
    try {
      native.tools.prepare.mockResolvedValue(progress([{ tool: "yt-dlp", phase: "checking" }], new Promise(() => {})));
      render(() => <ToolsStep />);
      await vi.advanceTimersByTimeAsync(100);
      expect(screen.queryByTestId("tools-progress")).toBeNull();
      await vi.advanceTimersByTimeAsync(600);
      expect(screen.getByText("Checking for yt-dlp updates…")).toBeInTheDocument();
    } finally {
      vi.useRealTimers();
    }
  });
});

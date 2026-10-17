import { render, screen } from "@solidjs/testing-library";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";

import { VideoPreview } from "./video-preview";

describe("VideoPreview", () => {
  it("closes with its x, and has a corner to resize it", async () => {
    const onClose = vi.fn();
    render(() => (
      <VideoPreview url="media://video" time={0} playing={false} speed={1} offset={null} onClose={onClose} />
    ));
    expect(screen.getByTestId("video-preview")).toHaveStyle({ width: "240px" });
    expect(screen.getByTestId("video-resize")).toBeInTheDocument();
    await userEvent.setup().click(screen.getByRole("button", { name: "Close video" }));
    expect(onClose).toHaveBeenCalledOnce();
  });
});

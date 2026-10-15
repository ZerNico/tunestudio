import { render, screen } from "@solidjs/testing-library";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";

import { YoutubeOption } from "./youtube-option";

function setup() {
  const onStart = vi.fn();
  render(() => <YoutubeOption onStart={onStart} />);
  return { onStart, user: userEvent.setup() };
}

describe("YoutubeOption", () => {
  it("is a labelled card with a link field", () => {
    setup();
    const card = screen.getByRole("region", { name: "Paste a YouTube link" });
    expect(card).toContainElement(screen.getByRole("textbox", { name: "YouTube link" }));
  });

  it("enables Start once the field holds a link, and starts on Enter", async () => {
    const { onStart, user } = setup();
    const field = screen.getByRole("textbox", { name: "YouTube link" });
    const start = screen.getByRole("button", { name: "Start" });
    expect(start).toBeDisabled();

    await user.type(field, "youtu.be/dQw4w9WgXcQ");
    expect(start).toBeEnabled();
    // The hint stays the same once a link is recognised; only an invalid link changes it.
    expect(field).toHaveAccessibleDescription("Works with youtube.com, youtu.be and Shorts links.");

    await user.keyboard("{Enter}");
    expect(onStart).toHaveBeenCalledExactlyOnceWith("youtu.be/dQw4w9WgXcQ", "dQw4w9WgXcQ");
  });

  it("replaces typed text with a pasted link", async () => {
    const { onStart, user } = setup();
    const field = screen.getByRole("textbox", { name: "YouTube link" });
    await user.type(field, "draft");
    await user.paste("  https://www.youtube.com/watch?v=dQw4w9WgXcQ ");
    expect(field).toHaveValue("https://www.youtube.com/watch?v=dQw4w9WgXcQ");

    await user.click(screen.getByRole("button", { name: "Start" }));
    expect(onStart).toHaveBeenCalledExactlyOnceWith("https://www.youtube.com/watch?v=dQw4w9WgXcQ", "dQw4w9WgXcQ");
  });

  it("marks a non-link invalid only after the field is left", async () => {
    const { onStart, user } = setup();
    const field = screen.getByRole("textbox", { name: "YouTube link" });
    await user.type(field, "https://vimeo.com/123");
    expect(field).not.toHaveAttribute("aria-invalid");

    await user.tab();
    expect(field).toHaveAttribute("aria-invalid", "true");
    expect(screen.getByRole("button", { name: "Start" })).toBeDisabled();
    expect(onStart).not.toHaveBeenCalled();
  });
});

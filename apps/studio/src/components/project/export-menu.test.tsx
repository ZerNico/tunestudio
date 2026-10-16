import { render, screen } from "@solidjs/testing-library";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";

import { ExportMenu } from "./export-menu";

describe("ExportMenu", () => {
  it("offers the song folder and USDB's text, and closes on a choice", async () => {
    const onSongFolder = vi.fn();
    const onUsdb = vi.fn();
    render(() => <ExportMenu busy={false} onSongFolder={onSongFolder} onUsdb={onUsdb} noVideoLink />);
    const user = userEvent.setup();
    await user.click(screen.getByTestId("export-song"));
    expect(await screen.findByTestId("export-usdb")).toHaveTextContent("Add the song's YouTube video");
    await user.click(screen.getByTestId("export-usdb"));
    expect(onUsdb).toHaveBeenCalledOnce();
    expect(screen.queryByTestId("export-menu")).not.toBeInTheDocument();
    await user.click(screen.getByTestId("export-song"));
    await user.click(await screen.findByTestId("export-folder"));
    expect(onSongFolder).toHaveBeenCalledOnce();
  });
});

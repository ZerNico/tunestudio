import { render, screen } from "@solidjs/testing-library";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";

import { ExportMenu } from "./export-menu";

function setup(game: "tune-perfect" | "usdx" = "tune-perfect") {
  const props = { onSongFolder: vi.fn(), onUsdb: vi.fn(), onTryInGame: vi.fn(), onOpen: vi.fn() };
  render(() => <ExportMenu busy={false} game={game} tryShortcut="⌘T" {...props} />);
  return { ...props, user: userEvent.setup() };
}

describe("ExportMenu", () => {
  it("offers the song folder and USDB's text, and closes on a choice", async () => {
    const { onSongFolder, onUsdb, user } = setup();
    await user.click(screen.getByTestId("export-song"));
    expect(await screen.findByTestId("export-usdb")).toHaveTextContent("Export for USDB");
    await user.click(screen.getByTestId("export-usdb"));
    expect(onUsdb).toHaveBeenCalledOnce();
    expect(screen.queryByTestId("export-menu")).not.toBeInTheDocument();
    await user.click(screen.getByTestId("export-song"));
    await user.click(await screen.findByTestId("export-folder"));
    expect(onSongFolder).toHaveBeenCalledOnce();
  });

  it("tries the song in the chosen game, named with its key", async () => {
    const { onTryInGame, onOpen, user } = setup("usdx");
    await user.click(screen.getByTestId("export-song"));
    const item = await screen.findByRole("menuitem", { name: /Try in UltraStar Deluxe/ });
    expect(onOpen).toHaveBeenCalledOnce();
    expect(item).toHaveTextContent("⌘T");
    await user.click(item);
    expect(onTryInGame).toHaveBeenCalledOnce();
    expect(screen.queryByTestId("export-menu")).not.toBeInTheDocument();
  });
});

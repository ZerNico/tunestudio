import { render, screen } from "@solidjs/testing-library";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";

import type { Game } from "~/lib/games";

import { ExportMenu } from "./export-menu";

function setup(games: Game[] = ["tune-perfect"], shortcutGame: Game | null = games[0] ?? null) {
  const props = { onSongFolder: vi.fn(), onUsdb: vi.fn(), onTryInGame: vi.fn(), onOpen: vi.fn() };
  render(() => <ExportMenu busy={false} games={games} shortcutGame={shortcutGame} tryShortcut="⌘T" {...props} />);
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

  it("tries the song in each available game, with the key on the one it starts", async () => {
    const { onTryInGame, onOpen, user } = setup(["tune-perfect", "usdx", "performous"], "usdx");
    await user.click(screen.getByTestId("export-song"));
    const items = await screen.findAllByRole("menuitem", { name: /^Try in/ });
    expect(onOpen).toHaveBeenCalledOnce();
    expect(items.map((item) => item.textContent?.replace("⌘T", ""))).toEqual([
      "Try in Tune Perfect",
      "Try in UltraStar Deluxe",
      "Try in Performous",
    ]);
    expect(items[0]).not.toHaveTextContent("⌘T");
    expect(items[1]).toHaveTextContent("⌘T");
    await user.click(items[2]!);
    expect(onTryInGame).toHaveBeenCalledExactlyOnceWith("performous");
    expect(screen.queryByTestId("export-menu")).not.toBeInTheDocument();
  });

  it("has a plain Try in game without a game, which leaves it to main", async () => {
    const { onTryInGame, user } = setup([]);
    await user.click(screen.getByTestId("export-song"));
    const item = await screen.findByRole("menuitem", { name: /^Try in/ });
    expect(item).toHaveTextContent("Try in game⌘T");
    await user.click(item);
    expect(onTryInGame).toHaveBeenCalledExactlyOnceWith();
  });
});

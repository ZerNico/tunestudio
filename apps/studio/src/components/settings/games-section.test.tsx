import { render, screen } from "@solidjs/testing-library";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { GameUnusable } from "~/lib/errors";
import type { GamesStatus } from "~/lib/native/types";

import { Toaster } from "../ui/toast";
import { GamesSection } from "./games-section";

// The main process isn't there in jsdom: its client is the one thing replaced. The section only reads the route's hash.
const native = vi.hoisted(() => ({
  games: { status: vi.fn(), choose: vi.fn(), clear: vi.fn() },
}));
vi.mock("~/lib/native/client", () => ({ native }));
vi.mock("@tanstack/solid-router", () => ({ useRouter: () => ({ state: { location: { hash: "" } } }) }));

const FOUND: GamesStatus = {
  last: null,
  games: [
    { game: "tune-perfect", chosen: null, found: "/Applications/Tune Perfect.app" },
    { game: "usdx", chosen: null, found: null },
    { game: "vocaluxe", chosen: null, found: null },
    { game: "performous", chosen: null, found: null },
  ],
};
const NONE = withGame(FOUND, "tune-perfect", { found: null });

function withGame(status: GamesStatus, game: string, change: object): GamesStatus {
  return { ...status, games: status.games.map((entry) => (entry.game === game ? { ...entry, ...change } : entry)) };
}

beforeEach(() => {
  for (const call of Object.values(native.games)) call.mockReset();
  native.games.status.mockResolvedValue(FOUND);
});

function setup() {
  render(() => (
    <Toaster>
      <GamesSection />
    </Toaster>
  ));
  return userEvent.setup();
}

describe("GamesSection", () => {
  it("lists only the games there are, and offers to add the others", async () => {
    const user = setup();
    expect(await screen.findByText("Found at /Applications/Tune Perfect.app")).toBeInTheDocument();
    expect(screen.queryByTestId("game-usdx")).toBeNull();
    expect(screen.queryByTestId("games-empty")).toBeNull();
    // Found, not chosen: nothing to clear.
    expect(screen.queryByRole("button", { name: /^Clear/ })).toBeNull();

    await user.click(screen.getByRole("button", { name: "Add a game…" }));
    const items = await screen.findAllByRole("menuitem");
    expect(items.map((item) => item.textContent)).toEqual(["UltraStar Deluxe…", "Vocaluxe…", "Performous…"]);
  });

  it("adds a game, clears it, and says why an app can't be used", async () => {
    const user = setup();
    const chosen = withGame(FOUND, "usdx", {
      chosen: "/Applications/UltraStarDeluxe.app",
      found: "/Applications/UltraStarDeluxe.app",
    });
    native.games.choose.mockResolvedValueOnce(chosen);
    await user.click(await screen.findByRole("button", { name: "Add a game…" }));
    await user.click(await screen.findByRole("menuitem", { name: "UltraStar Deluxe…" }));
    expect(native.games.choose).toHaveBeenCalledWith({ game: "usdx" });
    expect(await screen.findByTestId("game-usdx-path")).toHaveTextContent("/Applications/UltraStarDeluxe.app");

    native.games.clear.mockResolvedValueOnce(FOUND);
    await user.click(screen.getByRole("button", { name: "Clear UltraStar Deluxe" }));
    expect(native.games.clear).toHaveBeenCalledWith({ game: "usdx" });
    await vi.waitFor(() => expect(screen.queryByTestId("game-usdx")).toBeNull());

    native.games.choose.mockRejectedValueOnce(new GameUnusable({ message: "“Notes.app” isn't an app." }));
    await user.click(screen.getByRole("button", { name: "Choose Tune Perfect" }));
    expect(native.games.choose).toHaveBeenLastCalledWith({ game: "tune-perfect" });
    expect(await screen.findByText("“Notes.app” isn't an app.")).toBeInTheDocument();
    expect(screen.getByText("Couldn't use this app")).toBeInTheDocument();
  });

  it("keeps a chosen app that can't be started anymore, to fix or clear", async () => {
    native.games.status.mockResolvedValue(withGame(NONE, "vocaluxe", { chosen: "/Apps/Vocaluxe.app", found: null }));
    setup();
    expect(await screen.findByText("Can't be started from /Apps/Vocaluxe.app")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Choose Vocaluxe" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Clear Vocaluxe" })).toBeInTheDocument();
  });

  it("says when there is no game, and every game can be added", async () => {
    native.games.status.mockResolvedValue(NONE);
    const user = setup();
    expect(await screen.findByText("No games found. Add one to try songs in it.")).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Add a game…" }));
    expect(await screen.findAllByRole("menuitem")).toHaveLength(4);
  });

  it("has nothing to add when every game is there", async () => {
    native.games.status.mockResolvedValue({
      last: null,
      games: FOUND.games.map((entry) => ({ ...entry, found: `/Applications/${entry.game}.app` })),
    });
    setup();
    expect(await screen.findByTestId("game-performous")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Add a game…" })).toBeNull();
  });
});

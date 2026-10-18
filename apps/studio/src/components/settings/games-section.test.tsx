import { render, screen, within } from "@solidjs/testing-library";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { GameUnusable } from "~/lib/errors";
import type { GamesStatus } from "~/lib/native/types";

import { Toaster } from "../ui/toast";
import { GamesSection } from "./games-section";

// The main process isn't there in jsdom: its client is the one thing replaced. The section only reads the route's hash.
const native = vi.hoisted(() => ({
  games: { status: vi.fn(), choose: vi.fn(), clear: vi.fn(), use: vi.fn() },
}));
vi.mock("~/lib/native/client", () => ({ native }));
vi.mock("@tanstack/solid-router", () => ({ useRouter: () => ({ state: { location: { hash: "" } } }) }));

const NONE: GamesStatus = {
  tryWith: "tune-perfect",
  games: [
    { game: "tune-perfect", chosen: null, found: "/Applications/Tune Perfect.app" },
    { game: "usdx", chosen: null, found: null },
    { game: "vocaluxe", chosen: null, found: null },
    { game: "performous", chosen: null, found: null },
  ],
};

const withGame = (status: GamesStatus, game: string, change: object): GamesStatus => ({
  ...status,
  games: status.games.map((entry) => (entry.game === game ? { ...entry, ...change } : entry)),
});

beforeEach(() => {
  for (const call of Object.values(native.games)) call.mockReset();
  native.games.status.mockResolvedValue(NONE);
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
  it("shows each game's app: found, chosen or not set", async () => {
    setup();
    expect(await screen.findByText("Found at /Applications/Tune Perfect.app")).toBeInTheDocument();
    expect(within(screen.getByTestId("game-usdx")).getByText("Not set")).toBeInTheDocument();
    expect(within(screen.getByTestId("game-performous")).getByText("Not set")).toBeInTheDocument();
    // Nothing chosen, nothing to clear.
    expect(screen.queryByRole("button", { name: /^Clear/ })).toBeNull();
    expect(screen.getByRole("combobox", { name: "Try in game opens" })).toHaveTextContent("Tune Perfect");
  });

  it("chooses an app, clears it, and says why one can't be used", async () => {
    const user = setup();
    const chosen = withGame(NONE, "usdx", {
      chosen: "/Applications/UltraStarDeluxe.app",
      found: "/Applications/UltraStarDeluxe.app",
    });
    native.games.choose.mockResolvedValueOnce(chosen);
    await user.click(await screen.findByRole("button", { name: "Choose UltraStar Deluxe" }));
    expect(native.games.choose).toHaveBeenCalledWith({ game: "usdx" });
    expect(await screen.findByTestId("game-usdx-path")).toHaveTextContent("/Applications/UltraStarDeluxe.app");

    native.games.clear.mockResolvedValueOnce(NONE);
    await user.click(screen.getByRole("button", { name: "Clear UltraStar Deluxe" }));
    expect(native.games.clear).toHaveBeenCalledWith({ game: "usdx" });
    expect(await within(screen.getByTestId("game-usdx")).findByText("Not set")).toBeInTheDocument();

    native.games.choose.mockRejectedValueOnce(new GameUnusable({ message: "“Notes.app” isn't an app." }));
    await user.click(screen.getByRole("button", { name: "Choose Vocaluxe" }));
    expect(await screen.findByText("“Notes.app” isn't an app.")).toBeInTheDocument();
    expect(screen.getByText("Couldn't use this app")).toBeInTheDocument();
  });

  it("says when a chosen app can't be started anymore", async () => {
    native.games.status.mockResolvedValue(withGame(NONE, "vocaluxe", { chosen: "/Apps/Vocaluxe.app", found: null }));
    setup();
    expect(await screen.findByText("Can't be started from /Apps/Vocaluxe.app")).toBeInTheDocument();
  });

  it("changes the game Try in game opens", async () => {
    const user = setup();
    native.games.use.mockResolvedValueOnce({ ...NONE, tryWith: "performous" });
    const select = await screen.findByRole("combobox", { name: "Try in game opens" });
    await vi.waitFor(() => expect(select).not.toHaveAttribute("data-disabled"));
    await user.click(select);
    await user.click(await screen.findByRole("option", { name: "Performous" }));
    expect(native.games.use).toHaveBeenCalledWith({ game: "performous" });
    await vi.waitFor(() => expect(select).toHaveTextContent("Performous"));
  });
});

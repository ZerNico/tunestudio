import { render, screen, within } from "@solidjs/testing-library";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { Notices } from "~/lib/licenses";

import { AboutSection } from "./about-section";

// The main process isn't there in jsdom: its client is the one thing replaced.
const native = vi.hoisted(() => ({ app: { openChromiumLicenses: vi.fn() } }));
vi.mock("~/lib/native/client", () => ({ native }));

/** What the build writes to `dist/licenses.json`, shortened. */
const NOTICES: Notices = {
  generated: true,
  javascript: [
    { name: "solid-js", version: "2.0.0", license: "MIT", url: "https://solidjs.com", text: 0 },
    { name: "drizzle-orm", version: "1.0.0", license: "Apache-2.0", url: null, text: 1 },
  ],
  libraries: [{ name: "ONNX Runtime", version: "1.31.0", license: "MIT", url: null, text: 0 }],
  crates: [{ name: "napi", version: "3.14.2", license: "MIT", url: null, text: 0 }],
  electron: { name: "Electron", version: "44.7.2", license: "MIT", url: "https://www.electronjs.org", text: 0 },
  texts: ["MIT License text", "Apache License text"],
};

const respond = (body: unknown) => new Response(JSON.stringify(body), { status: 200 });

function setup() {
  const onShowModels = vi.fn();
  render(() => <AboutSection version="1.2.3" onShowModels={onShowModels} />);
  return { onShowModels, user: userEvent.setup() };
}

const openLicenses = async (user: ReturnType<typeof userEvent.setup>) => {
  await user.click(screen.getByRole("button", { name: "Show licenses" }));
  return screen.findByRole("dialog", { name: "Open source licenses" });
};

describe("AboutSection", () => {
  beforeEach(() => vi.stubGlobal("fetch", vi.fn().mockResolvedValue(respond(NOTICES))));
  afterEach(() => vi.unstubAllGlobals());

  it("shows the version and the app's MIT license", async () => {
    const { user } = setup();
    expect(screen.getByRole("region", { name: "About" })).toHaveTextContent("Version 1.2.3");
    expect(screen.getByText("Free and open source under the MIT license.")).toBeVisible();

    await user.click(screen.getByRole("button", { name: "Read the license" }));
    const dialog = await screen.findByRole("dialog", { name: "MIT license" });
    expect(dialog).toHaveTextContent("Copyright (c) 2026 Nico Franke");
  });

  // Runs first among the list's tests: the notices are fetched once and kept after that.
  it("says when the licenses can't be loaded and tries again", async () => {
    const fetch = vi
      .fn()
      .mockResolvedValueOnce(new Response(null, { status: 404 }))
      .mockResolvedValue(respond(NOTICES));
    vi.stubGlobal("fetch", fetch);
    const { user } = setup();
    const dialog = await openLicenses(user);

    expect(await within(dialog).findByTestId("licenses-error")).toHaveTextContent("Couldn't load the licenses.");
    await user.click(within(dialog).getByRole("button", { name: "Try again" }));
    expect(await within(dialog).findByRole("region", { name: "App libraries (2)" })).toBeVisible();
    expect(fetch).toHaveBeenCalledWith("/licenses.json");
  });

  it("lists each group, and shows a notice's text only while it is open", async () => {
    const { user } = setup();
    const dialog = await openLicenses(user);

    const apps = await within(dialog).findByRole("region", { name: "App libraries (2)" });
    const nativeGroup = within(dialog).getByRole("region", { name: "Native libraries (2)" });
    expect(
      within(nativeGroup)
        .getAllByRole("listitem")
        .map((item) => item.textContent),
    ).toEqual([expect.stringContaining("ONNX Runtime"), expect.stringContaining("napi")]);
    expect(within(dialog).getByRole("region", { name: "Downloaded tools (4)" })).toHaveTextContent("GPL-3.0-or-later");
    expect(within(dialog).getByRole("region", { name: "Models" })).toBeVisible();
    expect(within(dialog).getByRole("region", { name: "Electron and Chromium" })).toHaveTextContent("Chromium");

    const drizzle = within(apps).getByRole("button", { name: /drizzle-orm/ });
    expect(drizzle).toHaveAttribute("aria-expanded", "false");
    expect(within(dialog).queryByText("Apache License text")).toBeNull();

    await user.click(drizzle);
    expect(drizzle).toHaveAttribute("aria-expanded", "true");
    expect(within(dialog).getByText("Apache License text")).toBeVisible();

    // The keyboard closes it again.
    drizzle.focus();
    await user.keyboard("{Enter}");
    expect(drizzle).toHaveAttribute("aria-expanded", "false");
    expect(within(dialog).queryByText("Apache License text")).toBeNull();
  });

  it("searches by name or license, and Esc clears the search before closing", async () => {
    const { user } = setup();
    const dialog = await openLicenses(user);
    await within(dialog).findByRole("region", { name: "App libraries (2)" });
    const search = within(dialog).getByRole("searchbox", { name: "Search licenses" });

    await user.type(search, "apache");
    expect(within(dialog).getByRole("region", { name: "App libraries (1)" })).toHaveTextContent("drizzle-orm");
    expect(within(dialog).queryByRole("region", { name: /Native libraries/ })).toBeNull();
    expect(within(dialog).queryByRole("region", { name: "Models" })).toBeNull();

    await user.clear(search);
    await user.type(search, "nothing like this");
    expect(within(dialog).getByText("No licenses match “nothing like this”.")).toBeVisible();

    await user.keyboard("{Escape}");
    expect(search).toHaveValue("");
    expect(screen.getByRole("dialog", { name: "Open source licenses" })).toBeVisible();
  });

  it("leads to the models and opens Chromium's licenses", async () => {
    native.app.openChromiumLicenses.mockReset().mockResolvedValue(undefined);
    const { user, onShowModels } = setup();
    const dialog = await openLicenses(user);

    await user.click(await within(dialog).findByRole("button", { name: "Open in browser" }));
    expect(native.app.openChromiumLicenses).toHaveBeenCalledOnce();

    await user.click(within(dialog).getByRole("button", { name: "Show models" }));
    expect(onShowModels).toHaveBeenCalledOnce();
    await expect.poll(() => screen.queryByRole("dialog", { name: "Open source licenses" })).toBeNull();
  });
});

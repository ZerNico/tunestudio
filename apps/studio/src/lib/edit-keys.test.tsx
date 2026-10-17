import { describe, expect, it, vi } from "vitest";

import { controlKey, inMenu, openContextMenu } from "./edit-commands";

function element(html: string, selector: string): Element {
  document.body.innerHTML = html;
  return document.querySelector(selector)!;
}

describe("which keys the editor takes", () => {
  it("leaves every key to an open menu or list", () => {
    expect(inMenu(element('<div role="listbox"><div role="option" id="o"></div></div>', "#o"))).toBe(true);
    expect(inMenu(element('<div id="o"></div>', "#o"))).toBe(false);
  });

  it("leaves Enter and Tab to a focused button, and arrows only to controls that use them", () => {
    const button = element('<button id="b"></button>', "#b");
    expect(controlKey(button, "Enter")).toBe(true);
    expect(controlKey(button, "Tab")).toBe(true);
    // Space plays, and arrows move notes, even with a toolbar button focused.
    expect(controlKey(button, " ")).toBe(false);
    expect(controlKey(button, "ArrowLeft")).toBe(false);
    expect(controlKey(element('<div role="slider" id="s"></div>', "#s"), "ArrowLeft")).toBe(true);
    expect(controlKey(document.body, "Enter")).toBe(false);
  });

  it("opens the right-click menu with Shift+F10 or the menu key", () => {
    const chip = element('<button id="c"></button>', "#c");
    const opened = vi.fn();
    chip.addEventListener("contextmenu", opened);
    expect(openContextMenu(new KeyboardEvent("keydown", { key: "F10", shiftKey: true }), chip)).toBe(true);
    expect(openContextMenu(new KeyboardEvent("keydown", { key: "ContextMenu" }), chip)).toBe(true);
    expect(openContextMenu(new KeyboardEvent("keydown", { key: "F10" }), chip)).toBe(false);
    expect(opened).toHaveBeenCalledTimes(2);
  });
});

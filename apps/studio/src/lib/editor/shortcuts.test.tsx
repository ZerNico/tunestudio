import { describe, expect, it } from "vitest";

import { NOTE_FLAGS } from "./edits";
import { SHORTCUTS, shortcutGroups, shown } from "./shortcuts";
import { TOOLS } from "./tools";

describe("the editor's keys", () => {
  it("lists every shortcut, tool and note type once in the help", () => {
    const listed = shortcutGroups().flatMap((group) => group.rows.map((row) => row.does));
    expect(new Set(listed).size).toBe(listed.length);
    for (const shortcut of Object.values(SHORTCUTS)) expect(listed).toContain(shortcut.does);
    for (const tool of TOOLS) expect(listed).toContain(tool.label);
    expect(listed.filter((does) => NOTE_FLAGS.some((flag) => does.startsWith(flag.label)))).toHaveLength(
      NOTE_FLAGS.length,
    );
  });

  it("shows Mod as Ctrl off macOS", () => {
    // Tests run as a browser: not macOS.
    expect(shown("Mod+Shift+Z")).toBe("Ctrl+Shift+Z");
    expect(shown("Delete")).toBe("Del");
  });
});

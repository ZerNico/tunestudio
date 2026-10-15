import { describe, expect, it } from "vitest";

import { extensionOf, projectName, projectNameExtra, safeFileName, songFileName } from "./file-names";

describe("file names", () => {
  it("replaces characters no platform allows, and trims what Windows drops", () => {
    expect(safeFileName('AC/DC: "Back" <in> |Black|?*')).toBe("AC_DC_ _Back_ _in_ _Black___");
    expect(safeFileName("Tab\there\u0000")).toBe("Tab_here_");
    expect(safeFileName("Trailing dots... ")).toBe("Trailing dots");
    expect(safeFileName("  spaced   out  ")).toBe("spaced out");
  });

  it("falls back for empty and reserved names and shortens long ones", () => {
    expect(safeFileName("")).toBe("Untitled");
    expect(safeFileName("...")).toBe("Untitled");
    expect(safeFileName("CON")).toBe("Untitled");
    expect(safeFileName("x".repeat(300))).toHaveLength(120);
  });

  it("names songs `Artist - Title`", () => {
    expect(songFileName("Raum27", "Oft gesagt")).toBe("Raum27 - Oft gesagt");
    expect(songFileName(" ", "")).toBe("Unknown artist - Untitled");
  });

  it("finds extensions, not dotfiles", () => {
    expect(extensionOf("a.MP3")).toBe(".MP3");
    expect(extensionOf("archive.tar.gz")).toBe(".gz");
    expect(extensionOf(".hidden")).toBe("");
    expect(extensionOf("none")).toBe("");
  });
});

describe("project names", () => {
  it("is the file name without its folder and extension", () => {
    expect(projectName("/Music/Tune Studio/Queen - Bohemian Rhapsody.tunestudio")).toBe("Queen - Bohemian Rhapsody");
    expect(projectName("C:\\Songs\\Queen - Bohemian Rhapsody.tunestudio")).toBe("Queen - Bohemian Rhapsody");
  });

  it.each([
    ["/a/Queen - Bohemian Rhapsody.tunestudio", null],
    ["/a/Queen - Bohemian Rhapsody (Duet).tunestudio", "(Duet)"],
    ["/a/Queen - Bohemian Rhapsody (2).tunestudio", "(2)"],
    ["/a/My practice version.tunestudio", "My practice version"],
    ["/a/Bohemian Rhapsody.tunestudio", null],
    ["/a/queen - bohemian rhapsody.tunestudio", null],
    ["/a/Bohemian Rhapsody (Duet).tunestudio", "(Duet)"],
  ])("shows what %s adds to the song", (path, extra) => {
    expect(projectNameExtra(path, "Queen", "Bohemian Rhapsody")).toBe(extra);
  });
});

import fs from "node:fs";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { tempDir, type ZipEntry, zipOf } from "../testing";
import { isZip, unzip } from "./unzip";

let cleanups: (() => void)[] = [];
afterEach(() => {
  for (const cleanup of cleanups.toReversed()) cleanup();
  cleanups = [];
});

function unpacked(entries: ZipEntry[]) {
  const { dir, cleanup } = tempDir();
  cleanups.push(cleanup);
  const file = path.join(dir, "download.zip");
  fs.writeFileSync(file, zipOf(entries));
  return { file, folder: path.join(dir, "out") };
}

describe("unzip", () => {
  it("unpacks folders, files with their permissions and symlinks", async () => {
    const { file, folder } = unpacked([
      { name: "yt-dlp/" },
      { name: "yt-dlp/yt-dlp_linux", data: "#!/bin/sh\necho hi\n".repeat(50), mode: 0o755 },
      { name: "yt-dlp/_internal/libpython.so.3", data: "library" },
      { name: "yt-dlp/_internal/libpython.so", link: "libpython.so.3" },
    ]);
    expect(isZip(fs.readFileSync(file))).toBe(true);
    await unzip(file, folder);
    const executable = path.join(folder, "yt-dlp", "yt-dlp_linux");
    expect(fs.readFileSync(executable, "utf8")).toBe("#!/bin/sh\necho hi\n".repeat(50));
    expect(fs.statSync(executable).mode & 0o777).toBe(0o755);
    expect(fs.readlinkSync(path.join(folder, "yt-dlp", "_internal", "libpython.so"))).toBe("libpython.so.3");
    expect(fs.readFileSync(path.join(folder, "yt-dlp", "_internal", "libpython.so"), "utf8")).toBe("library");
  });

  it("refuses entries and links that would land outside the folder", async () => {
    const escape = unpacked([{ name: "../evil", data: "x" }]);
    await expect(unzip(escape.file, escape.folder)).rejects.toThrow("Unsafe path in the zip file: ../evil");
    const link = unpacked([{ name: "lib", link: "../../etc/passwd" }]);
    await expect(unzip(link.file, link.folder)).rejects.toThrow("Unsafe link in the zip file: lib");
  });

  it("refuses to write through a symlink, or to climb out through one", async () => {
    const through = unpacked([
      { name: "d", link: "sub" },
      { name: "d/x", data: "x" },
    ]);
    await expect(unzip(through.file, through.folder)).rejects.toThrow("Unsafe path in the zip file: d/x");
    // "s/d" points at the folder itself, so "s/d/../x" would really be outside.
    const climb = unpacked([
      { name: "s/d", link: ".." },
      { name: "l", link: "s/d/../x" },
    ]);
    await expect(unzip(climb.file, climb.folder)).rejects.toThrow("Unsafe link in the zip file: l");
    // On macOS and Windows "a" is "A" and "é" is "e" + accent: a link reached under another spelling.
    for (const [first, second] of [
      ["A", "a"],
      ["é", "é"],
    ]) {
      const alias = unpacked([
        { name: first!, link: "." },
        { name: `${second}/b`, link: ".." },
        { name: "B/c", link: "outside" },
      ]);
      await expect(unzip(alias.file, alias.folder)).rejects.toThrow(/^Unsafe (path|link) in the zip file/);
      expect(fs.existsSync(path.join(alias.folder, "..", "c"))).toBe(false);
    }
    for (const name of ["a:b", "NUL ", "x/com1.txt.", "x\\nul", "app.asar/x"]) {
      const windowsy = unpacked([{ name, data: "x" }]);
      await expect(unzip(windowsy.file, windowsy.folder)).rejects.toThrow(`Unsafe path in the zip file: ${name}`);
    }
    const absolute = unpacked([{ name: "l", link: "/etc/passwd" }]);
    await expect(unzip(absolute.file, absolute.folder)).rejects.toThrow("Unsafe link in the zip file: l");
  });

  it("refuses damaged, oversized, encrypted and repeated entries", async () => {
    const cases: [ZipEntry[], string][] = [
      [[{ name: "a", data: "hello", crc: 1234 }], "The zip file is damaged."],
      // Claims 10 bytes but inflates to far more: stopped after 11.
      [[{ name: "a", data: "x".repeat(100_000), size: 10 }], ""],
      [
        [
          { name: "a", data: "x", size: 1.5 * 1024 ** 3 },
          { name: "b", data: "x", size: 1.5 * 1024 ** 3 },
        ],
        "The zip file unpacks to more than 2 GB.",
      ],
      [[{ name: "a", data: "x", encrypted: true }], "Encrypted zip files aren't supported."],
      [
        [
          { name: "a", data: "first" },
          { name: "a", data: "second" },
        ],
        "",
      ],
    ];
    for (const [entries, message] of cases) {
      const { file, folder } = unpacked(entries);
      await expect(unzip(file, folder)).rejects.toThrow(message);
    }
  });

  it("tells a zip file from anything else", () => {
    expect(isZip(Buffer.from("\x1f\x8b\x08\x00"))).toBe(false);
    expect(isZip(Buffer.from("PK\x03\x04"))).toBe(true);
  });
});

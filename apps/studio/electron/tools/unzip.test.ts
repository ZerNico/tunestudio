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

  it("tells a zip file from anything else", () => {
    expect(isZip(Buffer.from("\x1f\x8b\x08\x00"))).toBe(false);
    expect(isZip(Buffer.from("PK\x03\x04"))).toBe(true);
  });
});

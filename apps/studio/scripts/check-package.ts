/**
 * Checks an app electron-builder has packed, before the installer is made (`package.ts` runs it): the native addon,
 * its loader and GPU libraries in `resources/native`, and in the archive the renderer, the license list, the main
 * process and the charting tables, without source maps. Then it loads the addon with Node, so a library it needs
 * that isn't there fails the build instead of the app.
 */
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { listPackage } from "@electron/asar";

import { currentSystem, GPU_LIBRARIES, VULKAN_SYSTEMS } from "./native-libraries.ts";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

/** Checks the packed app whose resources folder is `resources`; throws with everything that is wrong. */
export function checkPackage(resources: string) {
  const problems: string[] = [];

  const native = path.join(resources, "native");
  const nativeFiles = fs.existsSync(native) ? fs.readdirSync(native) : [];
  // On Windows also Microsoft's C++ runtime (`isCppRuntime`), at least its two main files.
  const cppRuntime = process.platform === "win32" ? ["msvcp140.dll", "vcruntime140.dll"] : [];
  for (const file of ["index.cjs", ...(GPU_LIBRARIES[currentSystem()] ?? []), ...cppRuntime]) {
    if (!nativeFiles.includes(file)) problems.push(`native/${file} is missing.`);
  }
  const addons = nativeFiles.filter((file) => file.endsWith(".node"));
  if (addons.length !== 1) problems.push(`native/ should hold one addon, not ${addons.length}.`);
  // Linked, the Vulkan loader would have to be there for the addon to load at all (`native/src/vulkan.rs`).
  if (addons.length === 1 && VULKAN_SYSTEMS.has(currentSystem())) {
    const vulkan = linkedLibraries(path.join(native, addons[0]!)).filter((name) => /vulkan/i.test(name));
    if (vulkan.length > 0) {
      problems.push(`The addon links ${vulkan.join(", ")}: it wouldn't load on a computer without a GPU driver.`);
    }
  }

  const archived = new Set(
    listPackage(path.join(resources, "app.asar"), { isPack: false }).map((entry) =>
      entry.replaceAll("\\", "/").replace(/^\//, ""),
    ),
  );
  const tables = fs.readdirSync(path.join(root, "electron/charting/data")).map((file) => `dist-electron/data/${file}`);
  for (const file of ["dist/index.html", "dist/licenses.json", "dist-electron/main.cjs", "dist-electron/preload.cjs"]) {
    if (!archived.has(file)) problems.push(`app.asar has no ${file}.`);
  }
  for (const file of tables) if (!archived.has(file)) problems.push(`app.asar has no ${file}.`);
  const maps = [...archived].filter((file) => file.endsWith(".map"));
  if (maps.length > 0) problems.push(`app.asar has source maps: ${maps.join(", ")}`);

  if (problems.length > 0) throw new Error(`The packaged app isn't complete:\n${problems.join("\n")}`);

  // Loading it resolves every library it links (Dawn, the C++ runtime), as the app will.
  const loader = path.join(native, "index.cjs");
  const exports = execFileSync(
    "node",
    ["-e", "console.log(Object.keys(require(process.argv[1])).sort().join(', '))", loader],
    { encoding: "utf8" },
  ).trim();
  console.log(`  • checked the package  native=${nativeFiles.toSorted().join(", ")}  addon exports=${exports}`);
}

/** The shared libraries a binary links: a Windows DLL's import table, an ELF file's `NEEDED` entries. */
function linkedLibraries(file: string): string[] {
  if (process.platform !== "win32") {
    const dynamic = execFileSync("readelf", ["-d", file], { encoding: "utf8" });
    return [...dynamic.matchAll(/\(NEEDED\)\s+Shared library: \[(.+?)\]/g)].map((match) => match[1]!);
  }
  const data = fs.readFileSync(file);
  const header = data.readUInt32LE(0x3c);
  const sectionCount = data.readUInt16LE(header + 6);
  const optionalHeader = header + 24;
  const sections = optionalHeader + data.readUInt16LE(header + 20);
  // A 64-bit (PE32+) file's data directories start 112 bytes into its optional header; imports are the second.
  const importTable = data.readUInt32LE(optionalHeader + 112 + 8);
  const offsetOf = (address: number) => {
    for (let index = 0; index < sectionCount; index++) {
      const section = sections + index * 40;
      const start = data.readUInt32LE(section + 12);
      const size = Math.max(data.readUInt32LE(section + 8), data.readUInt32LE(section + 16));
      if (address >= start && address < start + size) return address - start + data.readUInt32LE(section + 20);
    }
    throw new Error(`${file}: address ${address} is in no section.`);
  };
  const names: string[] = [];
  // 20-byte descriptors, the DLL's name at 12, ending with an empty one.
  for (let entry = offsetOf(importTable); data.readUInt32LE(entry + 12) !== 0; entry += 20) {
    const name = offsetOf(data.readUInt32LE(entry + 12));
    names.push(data.toString("latin1", name, data.indexOf(0, name)));
  }
  return names;
}

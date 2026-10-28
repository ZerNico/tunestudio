/**
 * Writes a release's update feed (`electron/updates/manifest.ts`) in the release job:
 *   bun scripts/update-manifest.ts <folder> <version>
 * Finds the update files among the release's files in `<folder>` (at any depth), and writes `latest.json` (their
 * names as GitHub stores them, sizes and SHA-256) and `latest.json.sig` (its Ed25519 signature) into the folder. The
 * private key comes from `TUNESTUDIO_UPDATE_KEY` (PKCS #8 PEM, `scripts/update-key.ts`). Every system must have its
 * file, so a release never leaves one behind.
 */
import { createHash, createPrivateKey, sign } from "node:crypto";
import fs from "node:fs";
import path from "node:path";

import { assetName, UPDATE_TARGETS, type UpdateFile, updateTarget } from "../electron/updates/manifest.ts";

const [folder, tag] = process.argv.slice(2);
if (!folder || !tag) throw new Error("Usage: bun scripts/update-manifest.ts <folder> <version>");
const version = tag.replace(/^v/, "");
const key = process.env.TUNESTUDIO_UPDATE_KEY;
if (!key) throw new Error("TUNESTUDIO_UPDATE_KEY isn't set.");

const files: Record<string, UpdateFile> = {};
for (const entry of fs.readdirSync(folder, { recursive: true, withFileTypes: true })) {
  const target = entry.isFile() ? updateTarget(entry.name) : null;
  if (!target) continue;
  if (!entry.name.includes(`_${version}_`)) throw new Error(`${entry.name} isn't version ${version}.`);
  if (files[target]) throw new Error(`Two update files for ${target}: ${files[target].name} and ${entry.name}.`);
  const bytes = fs.readFileSync(path.join(entry.parentPath, entry.name));
  files[target] = {
    name: assetName(entry.name),
    size: bytes.length,
    sha256: createHash("sha256").update(bytes).digest("hex"),
  };
}
const missing = UPDATE_TARGETS.filter((target) => !files[target]);
if (missing.length > 0) throw new Error(`No update file for ${missing.join(", ")}.`);

const manifest = `${JSON.stringify({ version, files }, null, 2)}\n`;
const signature = sign(null, Buffer.from(manifest), createPrivateKey(key)).toString("base64");
fs.writeFileSync(path.join(folder, "latest.json"), manifest);
fs.writeFileSync(path.join(folder, "latest.json.sig"), `${signature}\n`);
console.log(manifest);

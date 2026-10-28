/**
 * The update feed: each release has a `latest.json` naming its installers, and `latest.json.sig`, an Ed25519
 * signature of that file's bytes by the release key (`scripts/update-manifest.ts` writes both in the release job, the
 * only place the private key is). The app trusts a manifest only with a valid signature by the public key it was
 * built with, and an installer only with the size and SHA-256 the manifest names. Plain Node, no Electron: the
 * release script uses it too.
 */
import { createPublicKey, verify } from "node:crypto";

import { Schema } from "effect";

/** The system and processor an installer is for, as Node names them (`process.platform`-`process.arch`). */
export const UPDATE_TARGETS = ["darwin-arm64", "win32-x64", "linux-x64"] as const;
export type UpdateTarget = (typeof UPDATE_TARGETS)[number];

export const UpdateFile = Schema.Struct({
  /** The release asset's name, as GitHub stores it (spaces become dots). */
  name: Schema.String,
  size: Schema.Number,
  sha256: Schema.String,
});
export type UpdateFile = typeof UpdateFile.Type;

export const UpdateManifest = Schema.Struct({
  /** Without the tag's "v". */
  version: Schema.String,
  files: Schema.Record(Schema.String, UpdateFile),
});
export type UpdateManifest = typeof UpdateManifest.Type;

/**
 * Which system a release file updates, by its name (`package.ts` names them), or null when it isn't an update file:
 * the .app archive on macOS (the dmg is only for a first install), the installer on Windows, the AppImage on Linux.
 */
export function updateTarget(file: string): UpdateTarget | null {
  if (file.endsWith("_arm64.app.tar.gz")) return "darwin-arm64";
  if (file.endsWith("_x64-setup.exe")) return "win32-x64";
  if (file.endsWith("_x64.AppImage")) return "linux-x64";
  return null;
}

/** GitHub's name for an uploaded asset: it replaces spaces (and other characters it doesn't keep) with dots. */
export function assetName(file: string): string {
  return file.replace(/[^\w.-]/g, ".");
}

// An Ed25519 public key in DER (SPKI) is this prefix and the 32 key bytes.
const SPKI_PREFIX = Buffer.from("302a300506032b6570032100", "hex");

/** Whether `signature` (base64) is the release key's signature of `data`; `publicKey` is the raw key in base64. */
export function verifySignature(data: Uint8Array, signature: string, publicKey: string): boolean {
  const raw = Buffer.from(publicKey, "base64");
  if (raw.length !== 32) return false;
  const key = createPublicKey({ key: Buffer.concat([SPKI_PREFIX, raw]), format: "der", type: "spki" });
  const bytes = Buffer.from(signature.trim(), "base64");
  if (bytes.length !== 64) return false;
  return verify(null, data, key, bytes);
}

/** A version's numbers, or null for anything but `x.y.z` (a leading "v" is fine). */
function parts(version: string): [number, number, number] | null {
  const match = /^v?(\d+)\.(\d+)\.(\d+)$/.exec(version.trim());
  return match ? [Number(match[1]), Number(match[2]), Number(match[3])] : null;
}

/** Whether `candidate` is a later release than `current`. Versions that aren't `x.y.z` never are. */
export function isNewer(candidate: string, current: string): boolean {
  const [a, b] = [parts(candidate), parts(current)];
  if (!a || !b) return false;
  for (let i = 0; i < 3; i++) if (a[i] !== b[i]) return a[i]! > b[i]!;
  return false;
}

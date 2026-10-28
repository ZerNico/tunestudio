/**
 * Makes the release key that signs the update feed (`electron/updates/manifest.ts`):
 *   bun scripts/update-key.ts <private key file>
 * Writes the private key (PKCS #8 PEM, readable only by you) to the file, which must not exist yet, and prints the
 * public key for `electron/updates/key.ts`. The private key goes into the repository's `TUNESTUDIO_UPDATE_KEY`
 * Actions secret (`gh secret set TUNESTUDIO_UPDATE_KEY < <file>`) and a safe place; it is never printed. A new key
 * only reaches users with the release that carries its public half, so a lost key means one manual update for all.
 */
import { generateKeyPairSync } from "node:crypto";
import fs from "node:fs";

const file = process.argv[2];
if (!file) throw new Error("Usage: bun scripts/update-key.ts <private key file>");

const { privateKey, publicKey } = generateKeyPairSync("ed25519");
fs.writeFileSync(file, privateKey.export({ type: "pkcs8", format: "pem" }), { flag: "wx", mode: 0o600 });
// The raw key is the last 32 bytes of its DER (SPKI) form.
const raw = publicKey.export({ type: "spki", format: "der" }).subarray(-32);
console.log(raw.toString("base64"));

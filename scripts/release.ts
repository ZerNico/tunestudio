/**
 * Prepares a release on main: `bun run release 0.2.0` sets the app's version in apps/studio/package.json, commits it
 * and tags the commit `v0.2.0`. Pushing the tag starts `.github/workflows/draft-release.yaml`.
 */
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const manifest = path.join(root, "apps/studio/package.json");

function fail(message: string): never {
  console.error(message);
  process.exit(1);
}

const git = (...args: string[]) => execFileSync("git", args, { cwd: root, encoding: "utf8" }).trim();

const version = process.argv[2]?.replace(/^v/, "");
if (!version || !/^\d+\.\d+\.\d+$/.test(version)) fail("Usage: bun run release <major.minor.patch>");
const tag = `v${version}`;

if (git("branch", "--show-current") !== "main") fail("Releases are tagged on main.");
if (git("status", "--porcelain")) fail("Commit or stash your changes first.");
if (git("tag", "--list", tag)) fail(`${tag} exists already.`);

const text = fs.readFileSync(manifest, "utf8");
const current = (JSON.parse(text) as { version: string }).version;
if (current === version) fail(`The app is at ${version} already.`);
// Only the version line changes, so the file keeps its formatting.
fs.writeFileSync(manifest, text.replace(`"version": "${current}"`, `"version": "${version}"`));

git("add", manifest);
git("commit", "--message", `chore(release): ${tag}`);
git("tag", "--annotate", tag, "--message", tag);
console.log(`Tagged ${tag}. Push it to build the draft release:\n  git push origin main ${tag}`);

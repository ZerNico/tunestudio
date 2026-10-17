import fs from "node:fs";
import path from "node:path";

import { NodeServices } from "@effect/platform-node";
import { afterEach, describe, expect, it } from "@effect/vitest";
import { Effect, Layer } from "effect";

import type { RecentProjectEntry } from "../../src/lib/native/types";
import { tempDir } from "../testing";
import { Recents, recentsLayer } from "./recents";

let cleanup = () => {};
afterEach(() => cleanup());

function setup() {
  const made = tempDir();
  cleanup = made.cleanup;
  const file = path.join(made.dir, "data", "recent-projects.json");
  const run = <A, E>(effect: Effect.Effect<A, E, Recents>) =>
    Effect.runPromise(effect.pipe(Effect.provide(recentsLayer(file).pipe(Layer.provide(NodeServices.layer)))));
  const project = (name: string, lastOpened: string): RecentProjectEntry => {
    const projectPath = path.join(made.dir, `${name}.tunestudio`);
    fs.writeFileSync(projectPath, "");
    return { path: projectPath, title: name, artist: "Artist", lastOpened };
  };
  return { file, run, project };
}

describe("Recents", () => {
  it("starts empty and stores projects newest first, as versioned JSON", async () => {
    const { file, run, project } = setup();
    const a = project("A", "2026-10-01T10:00:00.000Z");
    const b = { ...project("B", "2026-10-02T10:00:00.000Z"), cover: "data:image/jpeg;base64,AAAA" };
    const list = await run(
      Effect.gen(function* () {
        const recents = yield* Recents;
        expect(yield* recents.list).toEqual([]);
        yield* recents.add(a);
        yield* recents.add(b);
        return yield* recents.list;
      }),
    );
    expect(list).toEqual([b, a]);
    expect(JSON.parse(fs.readFileSync(file, "utf8"))).toEqual({ version: 1, projects: [b, a] });
  });

  it("moves a reopened project to the top without duplicating it", async () => {
    const { run, project } = setup();
    const a = project("A", "2026-10-01T10:00:00.000Z");
    const b = project("B", "2026-10-02T10:00:00.000Z");
    const list = await run(
      Effect.gen(function* () {
        const recents = yield* Recents;
        yield* recents.add(a);
        yield* recents.add(b);
        yield* recents.add({ ...a, lastOpened: "2026-10-03T10:00:00.000Z", title: "A again" });
        return yield* recents.list;
      }),
    );
    expect(list.map((entry) => entry.title)).toEqual(["A again", "B"]);
  });

  it("removes a project and restores it in its place (undo)", async () => {
    const { run, project } = setup();
    const a = project("A", "2026-10-01T10:00:00.000Z");
    const b = project("B", "2026-10-02T10:00:00.000Z");
    const c = project("C", "2026-10-03T10:00:00.000Z");
    const [removed, restored] = await run(
      Effect.gen(function* () {
        const recents = yield* Recents;
        for (const entry of [a, b, c]) yield* recents.add(entry);
        yield* recents.remove(b.path);
        const afterRemove = yield* recents.list;
        yield* recents.restore(b);
        return [afterRemove, yield* recents.list];
      }),
    );
    expect(removed.map((entry) => entry.title)).toEqual(["C", "A"]);
    expect(restored.map((entry) => entry.title)).toEqual(["C", "B", "A"]);
  });

  it("drops projects whose file is gone when listing", async () => {
    const { file, run, project } = setup();
    const a = project("A", "2026-10-01T10:00:00.000Z");
    const b = project("B", "2026-10-02T10:00:00.000Z");
    await run(Effect.forEach([a, b], (entry) => Recents.use((recents) => recents.add(entry))));
    fs.rmSync(a.path);
    expect(await run(Recents.use((recents) => recents.list))).toEqual([b]);
    expect(JSON.parse(fs.readFileSync(file, "utf8")).projects).toEqual([b]);
  });

  it("keeps projects whose whole folder is gone, as on a drive that isn't plugged in", async () => {
    const { run, project } = setup();
    const a = project("A", "2026-10-01T10:00:00.000Z");
    const unplugged = { ...a, path: path.join(path.dirname(a.path), "Volume", "Song.tunestudio") };
    await run(Recents.use((recents) => recents.add(unplugged)));
    expect(await run(Recents.use((recents) => recents.list))).toEqual([unplugged]);
  });

  it("treats a damaged or foreign list as empty instead of failing", async () => {
    const { file, run, project } = setup();
    fs.mkdirSync(path.dirname(file), { recursive: true });
    for (const contents of [
      "not json",
      JSON.stringify({ version: 2, projects: [] }),
      JSON.stringify({ projects: 1 }),
    ]) {
      fs.writeFileSync(file, contents);
      expect(await run(Recents.use((recents) => recents.list))).toEqual([]);
    }
    const a = project("A", "2026-10-01T10:00:00.000Z");
    expect(
      await run(
        Effect.andThen(
          Recents.use((recents) => recents.add(a)),
          Recents.use((r) => r.list),
        ),
      ),
    ).toEqual([a]);
  });
});

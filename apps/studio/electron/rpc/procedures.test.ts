import fs from "node:fs";
import path from "node:path";

import { afterEach, describe, expect, it } from "@effect/vitest";
import { Deferred, Effect, Fiber, Layer, Stream } from "effect";

import { errorMessage } from "../../src/lib/native/errors";
import type { ImportProgress, OpenedProject } from "../../src/lib/native/types";
import { AppLog } from "../services/app-log";
import { soloChart, syntheticBytes, tempDir, testRuntime, writeSong } from "../testing";
import { nativeHandlers, progressStream } from "./procedures";
import { connectClient } from "./test-client";

let cleanups: (() => void | Promise<void>)[] = [];
afterEach(async () => {
  for (const cleanup of cleanups.toReversed()) await cleanup();
  cleanups = [];
});

/** The app's handlers on the real services (with a desktop that records), through the renderer's client. */
async function setup() {
  const { dir, cleanup } = tempDir();
  const test = testRuntime(dir);
  const { native } = await connectClient(test.runtime, nativeHandlers);
  cleanups.push(
    cleanup,
    () => test.runtime.dispose(),
    () => native.dispose(),
  );
  return { dir, ...test, rpc: native };
}

const testLog = Layer.succeed(AppLog, { write: () => Effect.void });

/** The message a failed call shows the user. */
async function rejection(promise: Promise<unknown>) {
  const error = await promise.then(
    () => expect.unreachable("the call should have failed"),
    (caught: unknown) => caught,
  );
  return { message: errorMessage(error) };
}

/** Drains an import's progress and returns it with the opened project. */
async function drain(iterator: AsyncIterator<ImportProgress, OpenedProject>) {
  const progress: ImportProgress[] = [];
  for (;;) {
    const next = await iterator.next();
    if (next.done) return { progress, project: next.value };
    progress.push(next.value);
  }
}

describe("app.log", () => {
  it("writes a renderer line through the AppLog service", async () => {
    const { lines, rpc } = await setup();
    await rpc.app.log({ level: "warn", message: "slow frame" });
    expect(lines).toEqual(["WARN renderer slow frame"]);
  });

  it("rejects input the Effect schema does not accept", async () => {
    const { lines, rpc } = await setup();
    const error = await rejection(rpc.app.log({ level: "info", message: "x" } as never));
    expect(error.message).toBe("Something went wrong. The details are in the log file.");
    expect(lines).toEqual([]);
  });
});

describe("paths from the renderer", () => {
  it("refuses paths the user didn't pick, drop or open", async () => {
    const { dir, rpc } = await setup();
    const folder = writeSong(dir, "Song", { "song.txt": soloChart() });
    for (const attempt of [
      rpc.song.inspect({ path: folder }),
      rpc.project.open({ path: path.join(dir, "x.tunestudio") }),
      rpc.files.reveal({ path: "/etc/passwd" }),
      rpc.recents.restore({ path: "/etc", title: "t", artist: "a", lastOpened: "2026-01-01" }),
    ]) {
      const error = await rejection(attempt);
      expect(error.message).toBe("Choose the file again: Tune Studio can only use files you picked or dropped.");
    }
  });

  it("returns null and grants nothing when a dialog is cancelled", async () => {
    const { rpc, recorded } = await setup();
    recorded.answers.push(null);
    expect(await rpc.dialogs.chooseSong()).toBeNull();
  });
});

describe("import, open, export and recents", () => {
  it("previews a cover image the user picked, and refuses a file that isn't one", async () => {
    const { rpc, recorded, dir } = await setup();
    const image = path.join(dir, "cover.png");
    fs.writeFileSync(image, Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]));
    recorded.answers.push(image);
    expect(await rpc.dialogs.chooseCoverImage()).toEqual({
      path: image,
      preview: `data:image/jpeg;base64,${fs.readFileSync(image).toString("base64")}`,
    });

    const text = path.join(dir, "notes.txt");
    fs.writeFileSync(text, "hello");
    recorded.answers.push(text);
    const error = await rejection(rpc.dialogs.chooseCoverImage());
    expect(error.message).toBe("“notes.txt” isn't a JPEG or PNG image.");
  });

  it("runs the whole flow through the procedures", async () => {
    const { dir, rpc, recorded } = await setup();
    const audio = syntheticBytes(1_200_000, 7);
    const folder = writeSong(dir, "Song", {
      "song.txt": soloChart(),
      "Test Artist - Night Signals.mp3": audio,
      "Test Artist - Night Signals [CO].jpg": syntheticBytes(500, 8),
    });

    recorded.answers.push(folder);
    expect(await rpc.dialogs.chooseSong()).toBe(folder);
    const inspection = await rpc.song.inspect({ path: folder });
    expect(inspection.suggestedName).toBe("Test Artist - Night Signals");

    // The project location defaults to Music/Tune Studio, which the dialog needs to exist.
    const target = path.join(dir, "Music", "Tune Studio", "Night Signals");
    recorded.answers.push(target);
    const location = await rpc.dialogs.chooseProjectLocation({ name: inspection.suggestedName });
    expect(location).toBe(`${target}.tunestudio`);
    expect(fs.existsSync(path.dirname(target))).toBe(true);

    const iterator = await rpc.song.import({ path: folder, includeVideo: true, target: location! });
    const { progress, project } = await drain(iterator);
    expect(project.path).toBe(`${target}.tunestudio`);
    expect(progress.at(-1)?.step).toBe("Finishing");

    const overview = await rpc.project.overview({ id: project.id });
    expect(overview).toMatchObject({
      path: project.path,
      notes: 6,
      lines: 2,
      goldenNotes: 1,
      song: { title: "Night Signals", artist: "Test Artist", bpm: 240 },
      importWarnings: [],
    });
    expect(overview.media.map((media) => [media.role, media.url])).toEqual([
      ["audio", `media://${project.id}/1`],
      ["cover", `media://${project.id}/2`],
    ]);

    const recents = await rpc.recents.list();
    expect(recents).toEqual([
      expect.objectContaining({
        path: project.path,
        title: "Night Signals",
        artist: "Test Artist",
        cover: expect.stringMatching(/^data:image\/jpeg;base64,/),
      }),
    ]);

    const exportFolder = path.join(dir, "Exports");
    fs.mkdirSync(exportFolder);
    recorded.answers.push(exportFolder);
    expect(await rpc.dialogs.chooseExportFolder()).toBe(exportFolder);
    const exported = await rpc.project.exportSong({ id: project.id, folder: exportFolder, replace: false });
    expect(exported.status).toBe("exported");
    const again = await rpc.project.exportSong({ id: project.id, folder: exportFolder, replace: false });
    expect(again).toEqual({ status: "exists", folder: path.join(exportFolder, "Test Artist - Night Signals") });
    await rpc.files.reveal({ path: again.folder });
    expect(recorded.revealed).toEqual([again.folder]);

    await rpc.project.close({ id: project.id });
    const closed = await rejection(rpc.project.overview({ id: project.id }));
    expect(closed.message).toBe("This project isn't open anymore. Open it again.");

    await rpc.recents.remove({ path: project.path });
    expect(await rpc.recents.list()).toEqual([]);
    await rpc.recents.restore(recents[0]!);
    const reopened = await rpc.project.open({ path: project.path });
    expect(reopened.path).toBe(project.path);
    expect((await rpc.recents.list()).map((entry) => entry.path)).toEqual([project.path]);
  });

  it("reports import failures to the renderer with their message", async () => {
    const { dir, rpc, recorded } = await setup();
    const folder = writeSong(dir, "Song", { "song.txt": soloChart() });
    recorded.answers.push(folder, path.join(dir, "out.tunestudio"));
    await rpc.dialogs.chooseSong();
    await rpc.dialogs.chooseProjectLocation({ name: "x" });
    const iterator = await rpc.song.import({
      path: folder,
      includeVideo: true,
      target: path.join(dir, "out.tunestudio"),
    });
    const error = await rejection(drain(iterator));
    expect(error.message).toBe("The audio file “Test Artist - Night Signals.mp3” is missing from the song folder.");
    expect(fs.existsSync(path.join(dir, "out.tunestudio"))).toBe(false);
  });
});

describe("progressStream", () => {
  it("hands over a result that was ready when the renderer stopped reading", async () => {
    const undelivered: string[] = [];
    const finished = Effect.runSync(Deferred.make<void>());
    const stream = progressStream<number, string, never, never, never>(
      (onProgress) => Effect.as(onProgress(1), "draft-1").pipe(Effect.ensuring(Deferred.succeed(finished, undefined))),
      (result) => Effect.sync(() => void undelivered.push(result)),
    );
    // The renderer is still on the progress when main has the result, and stops there.
    const reading = Effect.runFork(Stream.runForEach(stream, () => Effect.never).pipe(Effect.provide(testLog)));
    await Effect.runPromise(Deferred.await(finished));
    await Effect.runPromise(Fiber.interrupt(reading));
    expect(undelivered).toEqual(["draft-1"]);
  });

  it("doesn't hand over a result that was read to the end", async () => {
    const undelivered: string[] = [];
    const stream = progressStream<number, string, never, never, never>(
      (onProgress) => Effect.as(onProgress(1), "draft-1"),
      (result) => Effect.sync(() => void undelivered.push(result)),
    );
    const events = await Effect.runPromise(Stream.runCollect(stream).pipe(Effect.provide(testLog)));
    expect(events).toEqual([
      { _tag: "Progress", progress: 1 },
      { _tag: "Done", result: "draft-1" },
    ]);
    expect(undelivered).toEqual([]);
  });

  it("interrupts the work when the stream is stopped", async () => {
    let interrupted = false;
    const stream = progressStream<number, string, never, never>((onProgress) =>
      Effect.andThen(onProgress(1), Effect.never).pipe(
        Effect.onInterrupt(() => Effect.sync(() => void (interrupted = true))),
      ),
    );
    await Effect.runPromise(Stream.runHead(stream).pipe(Effect.provide(testLog)));
    expect(interrupted).toBe(true);
  });
});

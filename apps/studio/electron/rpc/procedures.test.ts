import fs from "node:fs";
import path from "node:path";

import { afterEach, describe, expect, it } from "@effect/vitest";
import { call, ORPCError } from "@orpc/server";
import { Effect, Layer, ManagedRuntime, Schema } from "effect";

import type { ImportProgress, OpenedProject } from "../../src/lib/native/types";
import { AppLog } from "../services/app-log";
import { soloChart, syntheticBytes, tempDir, testRuntime, writeSong } from "../testing";
import { runRpc } from "./base";
import { procedures, withProgress } from "./procedures";

class Missing extends Schema.TaggedError<Missing>()("Missing", { message: Schema.String }) {}

let cleanups: (() => void | Promise<void>)[] = [];
afterEach(async () => {
  for (const cleanup of cleanups.toReversed()) await cleanup();
  cleanups = [];
});

const context = { context: { window: null } };

function setup() {
  const { dir, cleanup } = tempDir();
  const test = testRuntime(dir);
  cleanups.push(cleanup, () => test.runtime.dispose());
  return { dir, ...test, rpc: procedures(test.runtime) };
}

async function rejection(promise: Promise<unknown>) {
  const error = await promise.catch((caught: unknown) => caught);
  expect(error).toBeInstanceOf(ORPCError);
  return error as ORPCError<string, unknown>;
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
    const { lines, rpc } = setup();
    await call(rpc.app.log, { level: "warn", message: "slow frame" }, context);
    expect(lines).toEqual(["WARN renderer slow frame"]);
  });

  it("rejects input the Effect schema does not accept", async () => {
    const { lines, rpc } = setup();
    const error = await rejection(call(rpc.app.log, { level: "info", message: "x" } as never, context));
    expect(error.code).toBe("BAD_REQUEST");
    expect(lines).toEqual([]);
  });
});

describe("paths from the renderer", () => {
  it("refuses paths the user didn't pick, drop or open", async () => {
    const { dir, rpc } = setup();
    const folder = writeSong(dir, "Song", { "song.txt": soloChart() });
    for (const attempt of [
      call(rpc.song.inspect, { path: folder }, context),
      call(rpc.project.open, { path: path.join(dir, "x.tunestudio") }, context),
      call(rpc.files.reveal, { path: "/etc/passwd" }, context),
      call(rpc.recents.restore, { path: "/etc", title: "t", artist: "a", lastOpened: "2026-01-01" }, context),
    ]) {
      const error = await rejection(attempt);
      expect(error.code).toBe("BAD_REQUEST");
      expect(error.message).toBe("Choose the file again: Tune Studio can only use files you picked or dropped.");
    }
  });

  it("returns null and grants nothing when a dialog is cancelled", async () => {
    const { rpc, recorded } = setup();
    recorded.answers.push(null);
    expect(await call(rpc.dialogs.chooseSong, undefined, context)).toBeNull();
  });
});

describe("import, open, export and recents", () => {
  it("previews a cover image the user picked, and refuses a file that isn't one", async () => {
    const { rpc, recorded, dir } = setup();
    const image = path.join(dir, "cover.png");
    fs.writeFileSync(image, Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]));
    recorded.answers.push(image);
    expect(await call(rpc.dialogs.chooseCoverImage, undefined, context)).toEqual({
      path: image,
      preview: `data:image/jpeg;base64,${fs.readFileSync(image).toString("base64")}`,
    });

    const text = path.join(dir, "notes.txt");
    fs.writeFileSync(text, "hello");
    recorded.answers.push(text);
    const error = await rejection(call(rpc.dialogs.chooseCoverImage, undefined, context));
    expect(error.message).toBe("“notes.txt” isn't a JPEG or PNG image.");
  });

  it("runs the whole flow through the procedures", async () => {
    const { dir, rpc, recorded } = setup();
    const audio = syntheticBytes(1_200_000, 7);
    const folder = writeSong(dir, "Song", {
      "song.txt": soloChart(),
      "Test Artist - Night Signals.mp3": audio,
      "Test Artist - Night Signals [CO].jpg": syntheticBytes(500, 8),
    });

    recorded.answers.push(folder);
    expect(await call(rpc.dialogs.chooseSong, undefined, context)).toBe(folder);
    const inspection = await call(rpc.song.inspect, { path: folder }, context);
    expect(inspection.suggestedName).toBe("Test Artist - Night Signals");

    // The project location defaults to Music/Tune Studio, which the dialog needs to exist.
    const target = path.join(dir, "Music", "Tune Studio", "Night Signals");
    recorded.answers.push(target);
    const location = await call(rpc.dialogs.chooseProjectLocation, { name: inspection.suggestedName }, context);
    expect(location).toBe(`${target}.tunestudio`);
    expect(fs.existsSync(path.dirname(target))).toBe(true);

    const iterator = await call(rpc.song.import, { path: folder, includeVideo: true, target: location! }, context);
    const { progress, project } = await drain(iterator);
    expect(project.path).toBe(`${target}.tunestudio`);
    expect(progress.at(-1)?.step).toBe("Finishing");

    const overview = await call(rpc.project.overview, { id: project.id }, context);
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

    const recents = await call(rpc.recents.list, undefined, context);
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
    expect(await call(rpc.dialogs.chooseExportFolder, undefined, context)).toBe(exportFolder);
    const exported = await call(
      rpc.project.exportSong,
      { id: project.id, folder: exportFolder, replace: false },
      context,
    );
    expect(exported.status).toBe("exported");
    const again = await call(rpc.project.exportSong, { id: project.id, folder: exportFolder, replace: false }, context);
    expect(again).toEqual({ status: "exists", folder: path.join(exportFolder, "Test Artist - Night Signals") });
    await call(rpc.files.reveal, { path: again.folder }, context);
    expect(recorded.revealed).toEqual([again.folder]);

    await call(rpc.project.close, { id: project.id }, context);
    const closed = await rejection(call(rpc.project.overview, { id: project.id }, context));
    expect(closed.message).toBe("This project isn't open anymore. Open it again.");

    await call(rpc.recents.remove, { path: project.path }, context);
    expect(await call(rpc.recents.list, undefined, context)).toEqual([]);
    await call(rpc.recents.restore, recents[0]!, context);
    const reopened = await call(rpc.project.open, { path: project.path }, context);
    expect(reopened.path).toBe(project.path);
    expect((await call(rpc.recents.list, undefined, context)).map((entry) => entry.path)).toEqual([project.path]);
  });

  it("reports import failures to the renderer with their message", async () => {
    const { dir, rpc, recorded } = setup();
    const folder = writeSong(dir, "Song", { "song.txt": soloChart() });
    recorded.answers.push(folder, path.join(dir, "out.tunestudio"));
    await call(rpc.dialogs.chooseSong, undefined, context);
    await call(rpc.dialogs.chooseProjectLocation, { name: "x" }, context);
    const iterator = await call(
      rpc.song.import,
      { path: folder, includeVideo: true, target: path.join(dir, "out.tunestudio") },
      context,
    );
    const error = await rejection(drain(iterator));
    expect(error.message).toBe("The audio file “Test Artist - Night Signals.mp3” is missing from the song folder.");
    expect(fs.existsSync(path.join(dir, "out.tunestudio"))).toBe(false);
  });
});

describe("withProgress", () => {
  it("cancels work whose call was cancelled before it started", async () => {
    const controller = new AbortController();
    controller.abort();
    let seen: AbortSignal | undefined;
    const iterator = withProgress<number, string>(async (_onProgress, signal) => {
      seen = signal;
      return "done";
    }, controller.signal);
    await iterator.next();
    expect(seen?.aborted).toBe(true);
  });

  it("hands over a result that finished after the call was cancelled", async () => {
    const controller = new AbortController();
    let finish!: (value: string) => void;
    const undelivered: string[] = [];
    const iterator = withProgress<number, string>(
      () => new Promise((resolve) => (finish = resolve)),
      controller.signal,
      (result) => void undelivered.push(result),
    );
    const pending = iterator.next();
    controller.abort();
    finish("draft-1");
    await pending;
    expect(undelivered).toEqual(["draft-1"]);
  });

  it("doesn't hand over a result that was delivered", async () => {
    const undelivered: string[] = [];
    const iterator = withProgress<number, string>(
      async () => "draft-1",
      undefined,
      (result) => void undelivered.push(result),
    );
    expect(await iterator.next()).toEqual({ done: true, value: "draft-1" });
    expect(undelivered).toEqual([]);
  });
});

describe("runRpc", () => {
  it("turns a typed failure into BAD_REQUEST with its message", async () => {
    const runtime = ManagedRuntime.make(Layer.empty);
    const error = await rejection(runRpc(runtime, Effect.fail(new Missing({ message: "The song folder moved." }))));
    expect(error.code).toBe("BAD_REQUEST");
    expect(error.message).toBe("The song folder moved.");
  });

  it("interrupts the Effect when the call is aborted", async () => {
    const runtime = ManagedRuntime.make(Layer.empty);
    const controller = new AbortController();
    let finished = false;
    const pending = runRpc(
      runtime,
      Effect.never.pipe(Effect.onInterrupt(() => Effect.sync(() => void (finished = true)))),
      controller.signal,
    );
    controller.abort();
    await expect(pending).rejects.toBeDefined();
    expect(finished).toBe(true);
  });

  it.effect("services can be swapped per test", () =>
    Effect.gen(function* () {
      const lines: string[] = [];
      yield* AppLog.use((log) => log.write("INFO", "test", "hello")).pipe(
        Effect.provide(
          Layer.succeed(AppLog, { write: (_level, _target, message) => Effect.sync(() => void lines.push(message)) }),
        ),
      );
      expect(lines).toEqual(["hello"]);
    }),
  );
});

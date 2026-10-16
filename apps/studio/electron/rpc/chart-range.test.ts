import fs from "node:fs";
import path from "node:path";

import { eq } from "drizzle-orm";
import { Effect, Layer } from "effect";
import { afterEach, describe, expect, it, vi } from "vitest";

import { replaceRange } from "../../src/lib/editor/chart-range";
import { createChartDocument } from "../../src/lib/editor/document";
import type { ChartRangeInput } from "../../src/lib/native/contract";
import { errorMessage } from "../../src/lib/native/errors";
import type { ImportProgress } from "../../src/lib/native/types";
import { Native, type NativeAddon } from "../native/native";
import { listMedia, readChunk } from "../project/media";
import { Projects } from "../project/projects";
import { media } from "../project/schema";
import { fakeAddon, soloChart, syntheticBytes, tempDir, testRuntime, writeSong } from "../testing";
import { Tools } from "../tools/tools";
import { nativeHandlers } from "./procedures";
import { connectClient } from "./test-client";

let cleanups: (() => void | Promise<void>)[] = [];
afterEach(async () => {
  for (const cleanup of cleanups.toReversed()) await cleanup();
  cleanups = [];
});

async function drain<T>(iterator: AsyncIterator<ImportProgress, T>) {
  const progress: ImportProgress[] = [];
  for (;;) {
    const next = await iterator.next();
    if (next.done) return { progress, result: next.value };
    progress.push(next.value);
  }
}

async function setup(overrides: Partial<NativeAddon> = {}, vocals = true) {
  const { dir, cleanup } = tempDir();
  const script = path.join(dir, "decode.cjs");
  fs.writeFileSync(
    script,
    `
const fs = require("node:fs");
const args = process.argv.slice(2);
const rate = Number(args[args.indexOf("-ar") + 1]);
const samples = new Float32Array(rate * 10).map((_, i) => 0.3 * Math.sin(2 * Math.PI * 220 * i / rate));
fs.writeFileSync(args.at(-1), Buffer.from(samples.buffer));
`,
  );
  const ffmpeg = path.join(dir, "ffmpeg");
  fs.writeFileSync(ffmpeg, `#!/bin/sh\nexec "${process.execPath}" "${script}" "$@"\n`, { mode: 0o755 });
  const ensure = vi.fn(() => Effect.succeed({ "yt-dlp": {}, quickjs: {}, ffmpeg: { ffmpeg, ffprobe: ffmpeg } }));
  const tools = Layer.succeed(Tools, {
    folder: path.join(dir, "tools"),
    status: Effect.succeed([]),
    ensure,
    remove: () => Effect.void,
  });
  const addon = { ...fakeAddon, ...overrides };
  const native = Layer.succeed(Native, { addon: Effect.succeed(addon) });
  const test = testRuntime(dir, { tools, native });
  const { native: rpc } = await connectClient(test.runtime, nativeHandlers);
  cleanups.push(
    cleanup,
    () => test.runtime.dispose(),
    () => rpc.dispose(),
  );
  const folder = writeSong(dir, "Song", {
    "song.txt": soloChart(vocals ? "#VOCALS:vocals.m4a" : ""),
    "Test Artist - Night Signals.mp3": syntheticBytes(4000),
    "vocals.m4a": syntheticBytes(3000, 2),
  });
  test.recorded.answers.push(folder);
  await rpc.dialogs.chooseSong();
  test.recorded.answers.push(path.join(dir, "Song.tunestudio"));
  const target = await rpc.dialogs.chooseProjectLocation({ name: "Song" });
  const { result: project } = await drain(
    await rpc.song.import({ path: folder, includeVideo: false, target: target! }),
  );
  const before = await rpc.project.chart({ id: project.id });
  // A gap beyond the imported notes, on the original 240 BPM / 1.2505 s grid.
  const input: ChartRangeInput = {
    id: project.id,
    singerId: before.singers[0]!.id,
    start: 3.5005,
    end: 4.5005,
    lines: ["da"],
    language: "en",
  };
  const session = await test.runtime.runPromise(Projects.use((projects) => projects.get(project.id)));
  const sources = () =>
    test.runtime.runPromise(
      Effect.gen(function* () {
        const rows = yield* listMedia(session.db);
        return yield* Effect.forEach(rows, (row) =>
          Effect.map(readChunk(session.db, row.id, 0), (bytes) => ({ row, bytes })),
        );
      }),
    );
  const run = (asked = input, signal?: AbortSignal) => rpc.project.chartRange(asked, { signal }).then(drain);
  return { ...test, rpc, session, input, before, sources, run, ensure };
}

describe("project.chartRange", () => {
  it.each(["gap", "middle"])(
    "generates and persists a %s replacement with exact undo/redo and untouched audio",
    async (where) => {
      const { rpc, input: requested, before, sources, run } = await setup();
      const input = where === "gap" ? requested : { ...requested, start: 1.5005, end: 1.7505 };
      const originalMedia = await sources();
      const { result, progress } = await run(input);
      expect(result).toMatchObject({ bpm: before.bpm, gap: before.gap });
      expect(result.vocals).toBe(originalMedia.find(({ row }) => row.role === "vocals")!.row.sha256);
      expect(
        result.lines[0]!.notes.map((note) => note.lyric)
          .join("")
          .trim(),
      ).toBe("da");
      expect(progress.some((item) => item.step === "Reading the song")).toBe(true);
      expect(await rpc.project.chart({ id: input.id })).toEqual(before);
      expect(await sources()).toEqual(originalMedia);

      // The real recorder's transaction goes through RPC and SQLite, including undo/redo ordering.
      const failures: unknown[] = [];
      const doc = createChartDocument({
        chart: before,
        save: (changes) => rpc.project.applyChanges({ id: input.id, changes }),
        onFailed: (error) => failures.push(error),
        selection: () => [],
        setSelection: () => {},
      });
      expect(doc.edit("Chart from lyrics", (tx) => replaceRange(tx, before, input.singerId, input, result))).toBe(true);
      await doc.saved();
      const after = await rpc.project.chart({ id: input.id });
      expect(after).not.toEqual(before);
      expect(after.singers[0]!.lines.length).toBeGreaterThan(before.singers[0]!.lines.length);
      doc.undo();
      await doc.saved();
      expect(await rpc.project.chart({ id: input.id })).toEqual(before);
      doc.redo();
      await doc.saved();
      expect(await rpc.project.chart({ id: input.id })).toEqual(after);
      expect(failures).toEqual([]);
      expect(await sources()).toEqual(originalMedia);
    },
  );

  it("does not count a one-ulp overlap at a shared grid boundary as a crossing note", async () => {
    const { rpc, input, before, run } = await setup();
    const line = before.singers[0]!.lines[0]!;
    const note = line.notes[0]!;
    const { id: _id, ...fields } = note;
    await rpc.project.applyChanges({
      id: input.id,
      changes: [
        {
          table: "note",
          id: note.id,
          before: { ...fields, lineId: line.id },
          after: { ...fields, lineId: line.id, start: 7.37, duration: 1 },
        },
      ],
    });
    expect(7.37 + 1).toBeGreaterThan(8.37);
    await expect(run({ ...input, start: 8.37, end: 9.5 })).resolves.toHaveProperty("result.lines");
  });

  it("rejects missing vocals and invalid input before tools or models", async () => {
    const { run, input, ensure } = await setup({}, false);
    for (const asked of [input, { ...input, end: input.start }, { ...input, end: 90 }, { ...input, lines: ["!"] }]) {
      await expect(run(asked)).rejects.toBeDefined();
    }
    await expect(run({ ...input, start: NaN })).rejects.toBeDefined();
    expect(ensure).not.toHaveBeenCalled();
  });

  it.each(["chart", "vocals"])("rejects a result if the %s changed during inference", async (kind) => {
    let entered!: () => void;
    const started = new Promise<void>((resolve) => {
      entered = resolve;
    });
    let resume!: () => void;
    const blocked = new Promise<void>((resolve) => {
      resume = resolve;
    });
    const test = await setup({
      transcribeNotes: async (...args) => {
        entered();
        await blocked;
        return fakeAddon.transcribeNotes(...args);
      },
    });
    const pending = test.run().catch((error: unknown) => errorMessage(error));
    await started;
    if (kind === "chart") {
      await test.rpc.project.applyChanges({
        id: test.input.id,
        changes: [{ table: "song", before: { title: test.before.song.title }, after: { title: "Changed" } }],
      });
    } else {
      await test.runtime.runPromise(
        test.session.db.update(media).set({ sha256: "changed" }).where(eq(media.role, "vocals")).pipe(Effect.orDie),
      );
    }
    resume();
    expect(await pending).toBe("The song changed. Chart the range again.");
    expect((await test.rpc.project.chart({ id: test.input.id })).singers).toEqual(test.before.singers);
  });

  it("cancels through the RPC signal without returning or writing notes", async () => {
    let entered!: () => void;
    const started = new Promise<void>((resolve) => {
      entered = resolve;
    });
    let abort!: () => void;
    const aborted = new Promise<void>((resolve) => {
      abort = resolve;
    });
    const test = await setup({
      transcribeNotes: async (_folder, _samples, _requests, _language, _progress, signal) => {
        entered();
        await new Promise<void>((_resolve, reject) => {
          signal!.addEventListener(
            "abort",
            () => {
              abort();
              reject(new Error("aborted"));
            },
            { once: true },
          );
        });
        throw new Error("should not complete");
      },
    });
    const controller = new AbortController();
    const pending = test.run(test.input, controller.signal).catch((error: unknown) => error);
    await started;
    controller.abort();
    await aborted;
    expect(await pending).toMatchObject({ name: "AbortError" });
    expect(await test.rpc.project.chart({ id: test.input.id })).toEqual(test.before);
  });

  it("starts a retry only after a stopped run's native work ends", async () => {
    // The octave check can't be stopped: the first run's call goes on after Stop.
    let entered!: () => void;
    const started = new Promise<void>((resolve) => {
      entered = resolve;
    });
    let release!: () => void;
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    let holding = false;
    let overlapped = false;
    let retrying = false;
    let modelsStarted!: () => void;
    const retryStarted = new Promise<void>((resolve) => {
      modelsStarted = resolve;
    });
    const test = await setup({
      trackPitch: async (...args) => {
        if (holding) overlapped = true;
        if (retrying) modelsStarted();
        return fakeAddon.trackPitch(...args);
      },
      harmonicRatios: async (...args) => {
        if (!retrying) {
          holding = true;
          entered();
          await held;
          holding = false;
        }
        return fakeAddon.harmonicRatios(...args);
      },
    });
    const controller = new AbortController();
    const first = test.run(test.input, controller.signal).catch((error: unknown) => error);
    await started;
    controller.abort();
    expect(await first).toMatchObject({ name: "AbortError" });
    retrying = true;
    const retry = test.run();
    // Without the wait the retry reaches the models while the first call is still held; with it, nothing happens.
    await Promise.race([retryStarted, new Promise((resolve) => setTimeout(resolve, 1000))]);
    expect(overlapped).toBe(false);
    release();
    await expect(retry).resolves.toHaveProperty("result.lines");
  });

  it("reports model failures as unexpected, not as advice", async () => {
    const test = await setup({
      harmonicRatios: async () => {
        throw new Error("ONNX session failed");
      },
    });
    const message = await test.run().catch((error: unknown) => errorMessage(error));
    expect(message).toBe("Something went wrong. The details are in the log file.");
  });
});

/**
 * The renderer's client (`src/lib/native/client.ts`) against the main process server (`server.ts`,
 * `port-protocol.ts`) over a MessageChannel, with stand-ins for two handlers: results, user-facing errors, bugs,
 * progress, cancelling and a port that closes.
 */
import { afterEach, describe, expect, it } from "@effect/vitest";
import { Effect, Layer } from "effect";

import { ProjectDamaged } from "../../src/lib/errors";
import { NativeRpcs } from "../../src/lib/native/contract";
import { errorMessage, isAbort } from "../../src/lib/native/errors";
import { tempDir, testRuntime } from "../testing";
import { nativeHandlers, progressStream } from "./procedures";
import { connectClient } from "./test-client";

let cleanups: (() => void | Promise<void>)[] = [];
afterEach(async () => {
  for (const cleanup of cleanups.toReversed()) await cleanup();
  cleanups = [];
});

/** The app's handlers, with stand-ins for opening a project and preparing the tools; `stopped(tag)` resolves when main
 * interrupts that call. */
async function connect() {
  const { dir, cleanup } = tempDir();
  const { runtime, lines } = testRuntime(dir);
  const interrupts = new Map<string, () => void>();
  const stoppedCalls = new Map<string, Promise<void>>();
  for (const tag of ["project.open", "tools.prepare"]) {
    stoppedCalls.set(tag, new Promise<void>((resolve) => interrupts.set(tag, resolve)));
  }
  const interrupted = (tag: string) => Effect.sync(() => interrupts.get(tag)?.());
  let slowStarted!: () => void;
  const started = new Promise<void>((resolve) => (slowStarted = resolve));
  const standIns = Layer.mergeAll(
    NativeRpcs.toLayerHandler("project.open", ({ path }) => {
      if (path === "damaged") return Effect.fail(new ProjectDamaged({ message: "This project file is damaged." }));
      if (path === "bug") return Effect.die(new Error("boom"));
      if (path === "slow") {
        return Effect.andThen(Effect.sync(slowStarted), Effect.never).pipe(
          Effect.onInterrupt(() => interrupted("project.open")),
        );
      }
      // An answer main shouldn't give: no id.
      if (path === "misshapen") return Effect.succeed({ path } as { id: string; path: string });
      return Effect.succeed({ id: "p1", path });
    }),
    NativeRpcs.toLayerHandler("tools.prepare", ({ tools }) =>
      progressStream((onProgress) =>
        Effect.gen(function* () {
          for (const tool of tools) yield* onProgress({ tool, phase: "downloading", received: 5, total: 10 });
          if (tools.includes("ffmpeg")) {
            return yield* Effect.never.pipe(Effect.onInterrupt(() => interrupted("tools.prepare")));
          }
          return tools.map((tool) => ({ tool, version: "1", checkedAt: 0 }));
        }),
      ),
    ),
  );
  const { native, closeServerEnd } = await connectClient(runtime, Layer.merge(nativeHandlers, standIns));
  cleanups.push(
    cleanup,
    () => runtime.dispose(),
    () => native.dispose(),
  );
  /** Resolves once a "slow" open is running in main. */
  return { native, stopped: (tag: string) => stoppedCalls.get(tag), lines, closeServerEnd, started };
}

describe("calls over a MessagePort", () => {
  it("returns a call's result", async () => {
    const { native } = await connect();
    expect(await native.project.open({ path: "/songs/a.tunestudio" })).toEqual({
      id: "p1",
      path: "/songs/a.tunestudio",
    });
  });

  it("rejects with the user-facing error class and its message", async () => {
    const { native } = await connect();
    const error = await native.project.open({ path: "damaged" }).catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(ProjectDamaged);
    expect(errorMessage(error)).toBe("This project file is damaged.");
    expect(isAbort(error)).toBe(false);
  });

  it("describes a bug generically, and logs it", async () => {
    const { native, lines } = await connect();
    const error = await native.project.open({ path: "bug" }).catch((caught: unknown) => caught);
    expect(errorMessage(error)).toBe("Something went wrong. The details are in the log file.");
    // …and the details are.
    expect(lines).toEqual([expect.stringMatching(/^ERROR rpc Error: boom\n\s+at /)]);
  });

  it("logs an answer that doesn't fit its schema", async () => {
    const { native, lines } = await connect();
    const error = await native.project.open({ path: "misshapen" }).catch((caught: unknown) => caught);
    expect(errorMessage(error)).toBe("Something went wrong. The details are in the log file.");
    expect(lines).toEqual([expect.stringContaining("ERROR rpc")]);
  });

  it("yields progress, then returns the result", async () => {
    const { native } = await connect();
    const iterator = await native.tools.prepare({ tools: ["yt-dlp", "quickjs"] });
    const seen: unknown[] = [];
    for (;;) {
      const next = await iterator.next();
      if (next.done) {
        expect(next.value).toEqual([
          { tool: "yt-dlp", version: "1", checkedAt: 0 },
          { tool: "quickjs", version: "1", checkedAt: 0 },
        ]);
        break;
      }
      seen.push(next.value);
    }
    expect(seen).toEqual([
      { tool: "yt-dlp", phase: "downloading", received: 5, total: 10 },
      { tool: "quickjs", phase: "downloading", received: 5, total: 10 },
    ]);
  });

  it("aborting a call with progress stops it in main", async () => {
    const { native, stopped } = await connect();
    const controller = new AbortController();
    const iterator = await native.tools.prepare({ tools: ["ffmpeg"] }, { signal: controller.signal });
    expect((await iterator.next()).done).toBe(false);
    const pending = iterator.next().catch((caught: unknown) => caught);
    controller.abort();
    expect(isAbort(await pending)).toBe(true);
    await stopped("tools.prepare");
  });

  it("aborting a call stops it in main", async () => {
    const { native, stopped, started } = await connect();
    const controller = new AbortController();
    const pending = native.project.open({ path: "slow" }, { signal: controller.signal }).catch((caught) => caught);
    await started;
    controller.abort();
    expect(isAbort(await pending)).toBe(true);
    await stopped("project.open");
  });

  it("fails calls in flight when main's end of the port closes", async () => {
    const { native, closeServerEnd, started } = await connect();
    const pending = native.project.open({ path: "slow" }).catch((caught: unknown) => caught);
    await started;
    closeServerEnd();
    const error = await pending;
    expect(isAbort(error)).toBe(false);
    expect(errorMessage(error)).toBe("Something went wrong. The details are in the log file.");
  });

  it("serves the other calls with the app's handlers", async () => {
    const { native } = await connect();
    expect(await native.recents.list()).toEqual([]);
  });
});

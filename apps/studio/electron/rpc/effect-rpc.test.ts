/**
 * The renderer's Effect RPC client (`src/lib/native/effect-client.ts`) against the main process server
 * (`effect-server.ts`, `port-protocol.ts`) over a Node MessageChannel, with stand-in handlers: results, user-facing
 * errors, bugs, progress, cancelling and a port that closes.
 */
import { MessageChannel, type MessagePort as NodePort } from "node:worker_threads";

import { afterEach, describe, expect, it } from "@effect/vitest";
import { Effect, Layer, ManagedRuntime } from "effect";

import { ProjectDamaged } from "../../src/lib/errors";
import { makeEffectNative } from "../../src/lib/native/effect-client";
import { errorMessage, isAbort } from "../../src/lib/native/errors";
import { NativeRpcs } from "../../src/lib/native/rpcs";
import { AppLog } from "../services/app-log";
import { progressStream, startEffectRpc } from "./effect-server";
import type { RpcPort } from "./port-protocol";

let cleanups: (() => void | Promise<void>)[] = [];
afterEach(async () => {
  for (const cleanup of cleanups.toReversed()) await cleanup();
  cleanups = [];
});

const fromNodePort = (port: NodePort): RpcPort => ({
  postMessage: (message) => port.postMessage(message),
  onMessage: (listener) => port.on("message", listener),
  onClose: (listener) => port.once("close", listener),
  start: () => port.start(),
  close: () => port.close(),
});

/** What the stand-in handlers saw: calls that were interrupted. */
function standIns() {
  const interrupted: string[] = [];
  let releaseOpen: () => void = () => {};
  const handlers = NativeRpcs.toLayer({
    "project.open": ({ path }) => {
      if (path === "damaged") return Effect.fail(new ProjectDamaged({ message: "This project file is damaged." }));
      if (path === "bug") return Effect.die(new Error("boom"));
      if (path === "slow")
        return Effect.callback<never>((resume) => {
          releaseOpen = () => resume(Effect.die(new Error("released")));
        }).pipe(Effect.onInterrupt(() => Effect.sync(() => void interrupted.push("project.open"))));
      return Effect.succeed({ id: "p1", path });
    },
    "tools.prepare": ({ tools }) =>
      progressStream((onProgress) =>
        Effect.gen(function* () {
          for (const tool of tools) yield* onProgress({ tool, phase: "downloading", received: 5, total: 10 });
          if (tools.includes("ffmpeg")) {
            return yield* Effect.never.pipe(
              Effect.onInterrupt(() => Effect.sync(() => void interrupted.push("tools.prepare"))),
            );
          }
          return tools.map((tool) => ({ tool, version: "1", checkedAt: 0 }));
        }),
      ),
  });
  return { handlers, interrupted, releaseOpen: () => releaseOpen() };
}

async function connect() {
  const lines: string[] = [];
  const runtime = ManagedRuntime.make(
    Layer.succeed(AppLog, {
      write: (level, target, message) => Effect.sync(() => void lines.push(`${level} ${target} ${message}`)),
    }),
  );
  const { handlers, interrupted } = standIns();
  const accept = await startEffectRpc(runtime, handlers);
  let serverEnd: NodePort | undefined;
  const client = makeEffectNative(() => {
    const { port1, port2 } = new MessageChannel();
    serverEnd = port2;
    accept(fromNodePort(port2), null);
    return port1;
  });
  cleanups.push(
    () => client.dispose(),
    () => runtime.dispose(),
  );
  return { client, interrupted, closeServerEnd: () => serverEnd?.close() };
}

/** Waits until `check` holds (messages cross the channel asynchronously). */
async function eventually(check: () => boolean) {
  for (let tries = 0; tries < 100 && !check(); tries++) await new Promise((resolve) => setTimeout(resolve, 5));
  expect(check()).toBe(true);
}

describe("Effect RPC over a MessagePort", () => {
  it("returns a call's result", async () => {
    const { client } = await connect();
    expect(await client.project.open({ path: "/songs/a.tunestudio" })).toEqual({
      id: "p1",
      path: "/songs/a.tunestudio",
    });
  });

  it("rejects with the user-facing error class and its message", async () => {
    const { client } = await connect();
    const error = await client.project.open({ path: "damaged" }).catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(ProjectDamaged);
    expect(errorMessage(error)).toBe("This project file is damaged.");
    expect(isAbort(error)).toBe(false);
  });

  it("describes a bug generically", async () => {
    const { client } = await connect();
    const error = await client.project.open({ path: "bug" }).catch((caught: unknown) => caught);
    expect(errorMessage(error)).toBe("Something went wrong. The details are in the log file.");
  });

  it("yields progress, then returns the result", async () => {
    const { client } = await connect();
    const iterator = await client.tools.prepare({ tools: ["yt-dlp", "quickjs"] });
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
    const { client, interrupted } = await connect();
    const controller = new AbortController();
    const iterator = await client.tools.prepare({ tools: ["ffmpeg"] }, { signal: controller.signal });
    expect((await iterator.next()).done).toBe(false);
    const pending = iterator.next().catch((caught: unknown) => caught);
    controller.abort();
    expect(isAbort(await pending)).toBe(true);
    await eventually(() => interrupted.includes("tools.prepare"));
  });

  it("aborting a call stops it in main", async () => {
    const { client, interrupted } = await connect();
    const controller = new AbortController();
    const pending = client.project.open({ path: "slow" }, { signal: controller.signal }).catch((caught) => caught);
    await new Promise((resolve) => setTimeout(resolve, 20));
    controller.abort();
    expect(isAbort(await pending)).toBe(true);
    await eventually(() => interrupted.includes("project.open"));
  });

  it("fails calls in flight when main's end of the port closes", async () => {
    const { client, closeServerEnd } = await connect();
    const pending = client.project.open({ path: "slow" }).catch((caught: unknown) => caught);
    await new Promise((resolve) => setTimeout(resolve, 20));
    closeServerEnd();
    const error = await pending;
    expect(isAbort(error)).toBe(false);
    expect(errorMessage(error)).toBe("Something went wrong. The details are in the log file.");
  });
});

/**
 * The renderer's side of Effect RPC (`rpcs.ts`): a client over a MessagePort (handed to main through the preload,
 * like the oRPC one), and a facade that gives components what they use today: promises, and for calls with progress
 * an iterator that yields the progress and returns the result, each with an AbortSignal that cancels the call in
 * main. Effect stays in here; components don't use it.
 *
 * Failures reject with the user-facing error classes (`src/lib/errors.ts`), as main failed.
 */
import { Context, Effect, Layer, ManagedRuntime, Schema, Stream } from "effect";
import { RpcClient, RpcClientError, type RpcMessage, type RpcSerialization } from "effect/rpc";

import { EFFECT_RPC_CONNECT_CHANNEL } from "./channel";
import { NativeRpcs } from "./rpcs";

const clientDefect = (message: string, cause: unknown) =>
  new RpcClientError.RpcClientError({ reason: new RpcClientError.RpcClientDefect({ message, cause }) });

/** What the client needs of its port: the browser's MessagePort, or a Node one in tests. */
export interface ClientPort {
  postMessage: (message: unknown) => void;
  addEventListener: (type: "message" | "close", listener: (event: { data?: unknown }) => void) => void;
  start: () => void;
  close: () => void;
}

/**
 * The client protocol over a port to main (`connect` makes it, when the first call is made): responses go to the call
 * that sent the request.
 */
const portProtocol = (connect: () => ClientPort) =>
  Layer.effect(RpcClient.Protocol)(
    RpcClient.Protocol.make(
      Effect.fnUntraced(function* (writeResponse, clientIds) {
        const port = connect();
        const owners = new Map<string | number, number>();
        let closed: RpcClientError.RpcClientError | undefined;
        const deliver = (clientId: number, message: RpcMessage.FromServerEncoded) =>
          void Effect.runFork(writeResponse(clientId, message));

        port.addEventListener("message", (event) => {
          const message = event.data as RpcMessage.FromServerEncoded;
          if (message._tag === "Defect") {
            for (const clientId of clientIds) deliver(clientId, message);
            return;
          }
          if (message._tag !== "Chunk" && message._tag !== "Exit") return;
          const clientId = owners.get(message.requestId);
          if (clientId === undefined) return;
          if (message._tag === "Exit") owners.delete(message.requestId);
          deliver(clientId, message);
        });
        // Electron fires `close` on a renderer port when main's end goes away.
        port.addEventListener("close", () => {
          const error = clientDefect("The connection to the app closed.", null);
          closed = error;
          owners.clear();
          for (const clientId of clientIds) deliver(clientId, { _tag: "ClientProtocolError", error });
        });
        port.start();
        yield* Effect.addFinalizer(() => Effect.sync(() => port.close()));

        return {
          send: (clientId, message) => {
            if (closed) return Effect.fail(closed);
            if (message._tag === "Request") owners.set(message.id, clientId);
            return Effect.try({
              try: () => port.postMessage(message),
              catch: (cause) => clientDefect("Couldn't send to the app.", cause),
            });
          },
          supportsAck: true,
          supportsTransferables: false,
          codecFor: Schema.toCodecJson as RpcSerialization.CodecFor,
        };
      }),
    ),
  );

/** A port to main: one end stays here, the other goes to the preload (via a message to our own window), which hands it on. */
function connectToMain(): ClientPort {
  const { port1, port2 } = new MessageChannel();
  // What is sent before main starts its end waits on the port.
  window.postMessage(EFFECT_RPC_CONNECT_CHANNEL, window.location.origin, [port2]);
  return port1;
}

class Native extends Context.Service<Native, RpcClient.FromGroup<typeof NativeRpcs, RpcClientError.RpcClientError>>()(
  "studio/Native",
) {}

/** A call's progress events, then its result. */
type ProgressEvent<P, A> =
  | { readonly _tag: "Progress"; readonly progress: P }
  | { readonly _tag: "Done"; readonly result: A };

type Options = { signal?: AbortSignal };

/** The calls that have moved to Effect RPC, shaped like the oRPC client's (`client.ts`), over the port `connect` makes. */
export function makeEffectNative(connect: () => ClientPort) {
  const runtime = ManagedRuntime.make(
    Layer.effect(Native)(RpcClient.make(NativeRpcs, { disableTracing: true })).pipe(
      Layer.provide(portProtocol(connect)),
    ),
  );

  /** One call's result; aborting `signal` interrupts it in main and rejects with the signal's reason (an AbortError). */
  const call = <A, E>(run: (client: Native["Service"]) => Effect.Effect<A, E>, signal?: AbortSignal): Promise<A> =>
    runtime.runPromise(Native.use(run), signal ? { signal } : undefined).catch((error: unknown) => {
      throw signal?.aborted ? signal.reason : error;
    });

  /**
   * A call with progress as an iterator that yields the progress and returns the result. Stopping it (`return`, or
   * aborting `signal`) interrupts the call in main.
   */
  const withProgress = async <P, A, E>(
    run: (client: Native["Service"]) => Stream.Stream<ProgressEvent<P, A>, E>,
    signal?: AbortSignal,
  ): Promise<AsyncIterator<P, A>> => {
    const client = await runtime.runPromise(Native.useSync((service) => service));
    const events = Stream.toAsyncIterable(run(client))[Symbol.asyncIterator]();
    const stop = () => void events.return?.();
    signal?.addEventListener("abort", stop, { once: true });
    const finish = () => signal?.removeEventListener("abort", stop);
    return {
      next: async () => {
        if (signal?.aborted) throw signal.reason;
        const next = await events.next().catch((error: unknown) => {
          finish();
          throw error;
        });
        if (next.done) {
          finish();
          throw signal?.aborted ? signal.reason : new Error("The call ended without a result.");
        }
        if (next.value._tag === "Done") {
          finish();
          void events.return?.();
          return { done: true, value: next.value.result };
        }
        return { done: false, value: next.value.progress };
      },
      return: async (value?: A) => {
        finish();
        await events.return?.();
        return { done: true, value: value as A };
      },
    };
  };

  return {
    project: {
      open: (input: { path: string }, options: Options = {}) =>
        call((client) => client["project.open"](input), options.signal),
    },
    tools: {
      prepare: (
        input: { tools: readonly ("yt-dlp" | "quickjs" | "ffmpeg")[]; force?: boolean },
        options: Options = {},
      ) => withProgress((client) => client["tools.prepare"](input), options.signal),
    },
    /** Closes the port (tests). */
    dispose: () => runtime.dispose(),
  };
}

export const effectNative = makeEffectNative(connectToMain);

/**
 * The renderer's client for the main process (`contract.ts`): Effect RPC over a MessagePort handed to main through the
 * preload, behind a facade components use without Effect. `native.project.open({ path })` returns a promise; a call
 * that reports progress (`native.song.import(...)`) returns a promise of an iterator that yields the progress and
 * returns the result. Each takes an AbortSignal (`{ signal }`) that cancels the call in main and rejects with the
 * signal's reason (an AbortError).
 *
 * Failures reject with the user-facing error classes (`src/lib/errors.ts`), as main failed; anything else is a bug
 * (`errorMessage` in `errors.ts` tells them apart).
 */
import { Context, Effect, Layer, ManagedRuntime, Schema, Stream } from "effect";
import {
  type Rpc,
  RpcClient,
  RpcClientError,
  type RpcGroup,
  type RpcMessage,
  RpcSchema,
  type RpcSerialization,
} from "effect/rpc";

import { RPC_CONNECT_CHANNEL } from "./channel";
import { NativeRpcs } from "./contract";

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
  window.postMessage(RPC_CONNECT_CHANNEL, window.location.origin, [port2]);
  return port1;
}

class Native extends Context.Service<Native, RpcClient.FromGroup<typeof NativeRpcs, RpcClientError.RpcClientError>>()(
  "studio/Native",
) {}

type Rpcs = RpcGroup.Rpcs<typeof NativeRpcs>;
type Tags = Rpc.Tag<Rpcs>;
type Options = { signal?: AbortSignal };

/** A call's progress events, then its result (`progress` in contract.ts). */
type ProgressEvent<P, A> =
  | { readonly _tag: "Progress"; readonly progress: P }
  | { readonly _tag: "Done"; readonly result: A };
type ProgressOf<E> = E extends { readonly _tag: "Progress"; readonly progress: infer P } ? P : never;
type ResultOf<E> = E extends { readonly _tag: "Done"; readonly result: infer A } ? A : never;

/** How a call looks on the facade. */
type Call<R extends Rpc.Any> = (
  input: Rpc.PayloadConstructor<R>,
  options?: Options,
) => [Rpc.SuccessChunk<R>] extends [never]
  ? Promise<Rpc.Success<R>>
  : Promise<AsyncIterator<ProgressOf<Rpc.SuccessChunk<R>>, ResultOf<Rpc.SuccessChunk<R>>>>;

type GroupOf<Tag> = Tag extends `${infer Group}.${string}` ? Group : never;

/** The calls by group, as their tags name them (`"project.open"` is `native.project.open`). */
export type NativeClient = {
  [Group in GroupOf<Tags>]: {
    [Tag in Tags as Tag extends `${Group}.${infer Name}` ? Name : never]: Call<Rpc.ExtractTag<Rpcs, Tag>>;
  };
};

type AnyCall = (input: unknown, options?: Options) => Promise<unknown>;
/** The Effect client's calls, by tag. */
type AnyClient = Readonly<Record<string, (input: never) => unknown>>;

/** The client over the port `connect` makes (when the first call is made), with `dispose` to close it (tests). */
export function makeNative(connect: () => ClientPort): NativeClient & { dispose: () => Promise<void> } {
  const runtime = ManagedRuntime.make(
    Layer.effect(Native)(RpcClient.make(NativeRpcs, { disableTracing: true })).pipe(
      Layer.provide(portProtocol(connect)),
    ),
  );
  const client = () => runtime.runPromise(Native.useSync((service): AnyClient => service));

  const call = async (tag: string, input: unknown, signal?: AbortSignal) => {
    const rpc = (await client())[tag] as (input: unknown) => Effect.Effect<unknown, unknown>;
    return runtime.runPromise(rpc(input), signal ? { signal } : undefined).catch((error: unknown) => {
      throw signal?.aborted ? signal.reason : error;
    });
  };

  /**
   * A call with progress as an iterator that yields the progress and returns the result. Stopping it (`return`, or
   * aborting `signal`) interrupts the call in main, until the result has come.
   */
  const withProgress = async (
    tag: string,
    input: unknown,
    signal?: AbortSignal,
  ): Promise<AsyncIterator<unknown, unknown>> => {
    const rpc = (await client())[tag] as (input: unknown) => Stream.Stream<ProgressEvent<unknown, unknown>, unknown>;
    const stream = rpc(input);
    const events = Stream.toAsyncIterable(stream)[Symbol.asyncIterator]();
    const stop = () => void events.return?.();
    signal?.addEventListener("abort", stop, { once: true });
    const finish = () => signal?.removeEventListener("abort", stop);
    return {
      next: async () => {
        if (signal?.aborted) throw signal.reason;
        try {
          const next = await events.next();
          if (next.done) throw signal?.aborted ? signal.reason : new Error("The call ended without a result.");
          if (next.value._tag === "Progress") return { done: false, value: next.value.progress };
          // Main has sent the result: cancelling now would make it think the result was lost.
          finish();
          await events.next();
          return { done: true, value: next.value.result };
        } catch (error) {
          finish();
          throw signal?.aborted ? signal.reason : error;
        }
      },
      return: async (value?: unknown) => {
        finish();
        await events.return?.();
        return { done: true, value };
      },
    };
  };

  const native: Record<string, Record<string, AnyCall>> = {};
  for (const [tag, rpc] of NativeRpcs.requests) {
    const [group = tag, name = tag] = tag.split(".");
    const streams = RpcSchema.isStreamSchema(rpc.successSchema);
    (native[group] ??= {})[name] = (input, options = {}) =>
      streams ? withProgress(tag, input, options.signal) : call(tag, input, options.signal);
  }
  return Object.assign(native as NativeClient, { dispose: () => runtime.dispose() });
}

/** The client for the main process. */
export const native: NativeClient = makeNative(connectToMain);

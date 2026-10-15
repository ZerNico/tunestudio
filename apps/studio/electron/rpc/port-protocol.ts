/**
 * The server side of Effect RPC over MessagePorts: each renderer connection is one port and one client id. Messages
 * from a port are handled in the order they came (an Interrupt or Ack never overtakes its Request); a port that
 * closes (its window went away) disconnects its client, which interrupts its running calls.
 *
 * Values travel by structured clone, encoded as for JSON (`Schema.toCodecJson`), like Effect's worker protocol.
 * Electron's MessagePortMain can only transfer ports, so nothing is transferred: typed arrays are copied.
 */
import { Effect, FiberSet, Queue, Schema } from "effect";
import type { RpcMessage, RpcSerialization } from "effect/rpc";
import { RpcServer } from "effect/rpc";
import type { MessagePortMain } from "electron";

/** What the protocol needs of a port; Electron's MessagePortMain, or a Node one in tests. */
export interface RpcPort {
  postMessage: (message: unknown) => void;
  onMessage: (listener: (data: unknown) => void) => void;
  onClose: (listener: () => void) => void;
  start: () => void;
  close: () => void;
}

export function fromMessagePortMain(port: MessagePortMain): RpcPort {
  return {
    postMessage: (message) => port.postMessage(message),
    onMessage: (listener) => port.on("message", (event) => listener(event.data)),
    onClose: (listener) => port.once("close", listener),
    start: () => port.start(),
    close: () => port.close(),
  };
}

/**
 * A server protocol taking ports as they come (`accept`), each with something about its caller (`meta`, e.g. its
 * window), which handlers find again by their client id (`metaOf`).
 */
export const makePortProtocol = <Meta>() =>
  Effect.gen(function* () {
    const runFork = yield* FiberSet.makeRuntime<never, unknown, unknown>();
    const disconnects = yield* Queue.unbounded<number>();
    const connections = new Map<number, { port: RpcPort; meta: Meta; stop: () => void }>();
    let nextId = 0;
    // Set when the server starts, before any port is accepted.
    let writeRequest: ((clientId: number, message: RpcMessage.FromClientEncoded) => Effect.Effect<void>) | undefined;

    const drop = (clientId: number) => {
      const connection = connections.get(clientId);
      if (!connection) return;
      connections.delete(clientId);
      connection.stop();
      Queue.offerUnsafe(disconnects, clientId);
    };

    const protocol = yield* RpcServer.Protocol.make((write) => {
      writeRequest = write;
      return Effect.succeed({
        disconnects,
        send: (clientId, message) =>
          Effect.sync(() => {
            const port = connections.get(clientId)?.port;
            try {
              port?.postMessage(message);
            } catch {
              // The port closed in the meantime; its close event disconnects the client.
            }
          }),
        end: (clientId) => Effect.sync(() => drop(clientId)),
        clientIds: Effect.sync(() => new Set(connections.keys())),
        initialMessage: Effect.succeedNone,
        supportsAck: true,
        supportsTransferables: false,
        supportsSpanPropagation: true,
        supportsNotifications: false,
        codecFor: Schema.toCodecJson as RpcSerialization.CodecFor,
      });
    });

    yield* Effect.addFinalizer(() =>
      Effect.sync(() => {
        for (const connection of connections.values()) connection.port.close();
        connections.clear();
      }),
    );

    return {
      protocol,
      /** Serves calls from `port` until it closes. */
      accept: (port: RpcPort, meta: Meta) => {
        const clientId = nextId++;
        const fiber = runFork(
          Effect.gen(function* () {
            const mailbox = yield* Queue.unbounded<RpcMessage.FromClientEncoded>();
            port.onMessage((data) => Queue.offerUnsafe(mailbox, data as RpcMessage.FromClientEncoded));
            port.onClose(() => drop(clientId));
            port.start();
            return yield* Effect.forever(
              Effect.flatMap(Queue.take(mailbox), (message) => writeRequest?.(clientId, message) ?? Effect.void),
            );
          }),
        );
        connections.set(clientId, { port, meta, stop: () => fiber.interruptUnsafe() });
      },
      metaOf: (clientId: number) => connections.get(clientId)?.meta,
    };
  });

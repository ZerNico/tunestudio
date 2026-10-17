/**
 * For tests: the renderer's client (`src/lib/native/client.ts`) connected to the server (`server.ts`) over a Node
 * MessageChannel, as a window's would be over Electron's. Not bundled into the app.
 */
import { MessageChannel, type MessagePort } from "node:worker_threads";

import type { Layer, ManagedRuntime } from "effect";

import { type ClientPort, makeNative } from "../../src/lib/native/client";
import type { AppLog } from "../services/app-log";
import type { RpcPort } from "./port-protocol";
import type { Callers, nativeHandlers } from "./procedures";
import { startRpcServer } from "./server";

const fromNodePort = (port: MessagePort): RpcPort => ({
  postMessage: (message) => port.postMessage(message),
  onMessage: (listener) => port.on("message", listener),
  onClose: (listener) => port.once("close", listener),
  start: () => port.start(),
  close: () => port.close(),
});

/** A client for `handlers` on `runtime`; `closeServerEnd` closes main's end of the port, as a closing window would. */
export async function connectClient<R>(
  runtime: ManagedRuntime.ManagedRuntime<R | AppLog, never>,
  handlers: Layer.Layer<Layer.Success<typeof nativeHandlers>, never, R | Callers>,
) {
  const accept = await startRpcServer(runtime, handlers);
  let serverEnd: MessagePort | undefined;
  const native = makeNative(() => {
    const { port1, port2 } = new MessageChannel();
    serverEnd = port2;
    accept(fromNodePort(port2), null);
    // Node 24's types give the listener a plain Event; its message events carry `data` as the renderer's do.
    return port1 as ClientPort;
  });
  return { native, closeServerEnd: () => serverEnd?.close() };
}

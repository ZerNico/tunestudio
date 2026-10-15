import { RPCHandler } from "@orpc/server/message-port";
import { type BrowserWindow, ipcMain } from "electron";

import { EFFECT_RPC_CONNECT_CHANNEL, RPC_CONNECT_CHANNEL } from "../../src/lib/native/channel";
import { originOf } from "../protocols/schemes";
import type { StudioRuntime } from "../runtime";
import { os } from "./base";
import { fromMessagePortMain, type RpcPort } from "./port-protocol";
import { procedures } from "./procedures";

export function createRpcHandler(runtime: StudioRuntime) {
  return new RPCHandler(os.router(procedures(runtime)));
}

/**
 * Serves the contract on every MessagePort a window's preload forwards (oRPC), and the Effect RPC calls on the ports
 * forwarded for them (`acceptEffect`, which can still be starting). Only the top-level frame of one of the app's own
 * windows, on the app's origin, may connect.
 */
export function listenForRpc(
  handler: ReturnType<typeof createRpcHandler>,
  acceptEffect: Promise<(port: RpcPort, window: BrowserWindow | null) => void>,
  appOrigin: string,
  windowFor: (id: number) => BrowserWindow | null,
) {
  const connect = (
    event: Electron.IpcMainEvent,
    use: (port: Electron.MessagePortMain, window: BrowserWindow) => void,
  ) => {
    const frame = event.senderFrame;
    if (!frame || frame.parent || originOf(frame.url) !== appOrigin) return;
    const window = windowFor(event.sender.id);
    if (!window || window.webContents !== event.sender) return;
    const [port] = event.ports;
    if (port) use(port, window);
  };
  ipcMain.on(RPC_CONNECT_CHANNEL, (event) =>
    connect(event, (port, window) => {
      handler.upgrade(port, { context: { window } });
      port.start();
    }),
  );
  // Messages wait on the port until the server takes it.
  ipcMain.on(EFFECT_RPC_CONNECT_CHANNEL, (event) =>
    connect(event, (port, window) => void acceptEffect.then((accept) => accept(fromMessagePortMain(port), window))),
  );
}

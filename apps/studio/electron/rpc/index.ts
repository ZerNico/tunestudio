import { RPCHandler } from "@orpc/server/message-port";
import { type BrowserWindow, ipcMain } from "electron";

import { RPC_CONNECT_CHANNEL } from "../../src/lib/native/channel";
import { originOf } from "../protocols/schemes";
import type { StudioRuntime } from "../runtime";
import { os } from "./base";
import { procedures } from "./procedures";

export function createRpcHandler(runtime: StudioRuntime) {
  return new RPCHandler(os.router(procedures(runtime)));
}

/**
 * Serves the contract on every MessagePort a window's preload forwards. Only the top-level
 * frame of one of the app's own windows, on the app's origin, may connect.
 */
export function listenForRpc(
  handler: ReturnType<typeof createRpcHandler>,
  appOrigin: string,
  windowFor: (id: number) => BrowserWindow | null,
) {
  ipcMain.on(RPC_CONNECT_CHANNEL, (event) => {
    const frame = event.senderFrame;
    if (!frame || frame.parent || originOf(frame.url) !== appOrigin) return;
    const window = windowFor(event.sender.id);
    if (!window || window.webContents !== event.sender) return;

    const [port] = event.ports;
    if (!port) return;
    handler.upgrade(port, { context: { window } });
    port.start();
  });
}

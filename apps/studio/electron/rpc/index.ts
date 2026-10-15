import { type BrowserWindow, ipcMain } from "electron";

import { RPC_CONNECT_CHANNEL } from "../../src/lib/native/channel";
import { originOf } from "../protocols/schemes";
import { fromMessagePortMain, type RpcPort } from "./port-protocol";

/**
 * Serves the calls on every MessagePort a window's preload forwards (`accept`, from `startRpcServer`, which can still
 * be starting; messages wait on the port until it takes it). Only the top-level frame of one of the app's own windows,
 * on the app's origin, may connect.
 */
export function listenForRpc(
  accept: Promise<(port: RpcPort, window: BrowserWindow | null) => void>,
  appOrigin: string,
  windowFor: (id: number) => BrowserWindow | null,
) {
  ipcMain.on(RPC_CONNECT_CHANNEL, (event) => {
    const frame = event.senderFrame;
    if (!frame || frame.parent || originOf(frame.url) !== appOrigin) return;
    const window = windowFor(event.sender.id);
    if (!window || window.webContents !== event.sender) return;
    const [port] = event.ports;
    if (port) void accept.then((serve) => serve(fromMessagePortMain(port), window));
  });
}

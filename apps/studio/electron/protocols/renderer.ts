import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";

import { net, protocol } from "electron";

import { APP_ORIGIN, APP_SCHEME, originOf } from "./schemes";

/**
 * Serves the built frontend from `rendererDir` on `app://tunestudio`, falling back to
 * `index.html` for client-side routes. Paths never leave `rendererDir`, and every response
 * carries the app's CSP.
 */
export function handleRendererProtocol(rendererDir: string, contentSecurityPolicy: string) {
  protocol.handle(APP_SCHEME, async (request) => {
    if (originOf(request.url) !== APP_ORIGIN) return new Response(null, { status: 404 });

    const { pathname } = new URL(request.url);
    const requested = path.normalize(path.join(rendererDir, decodeURIComponent(pathname)));
    const insideRenderer = requested.startsWith(rendererDir + path.sep);
    const isFile = insideRenderer && fs.statSync(requested, { throwIfNoEntry: false })?.isFile();
    // Client routes have no extension; a missing asset is a real 404, not the app shell.
    if (!isFile && path.extname(pathname)) return new Response(null, { status: 404 });
    const file = isFile ? requested : path.join(rendererDir, "index.html");

    const response = await net.fetch(pathToFileURL(file).toString());
    const headers = new Headers(response.headers);
    headers.set("Content-Security-Policy", contentSecurityPolicy);
    headers.set("X-Content-Type-Options", "nosniff");
    return new Response(response.body, { status: response.status, headers });
  });
}

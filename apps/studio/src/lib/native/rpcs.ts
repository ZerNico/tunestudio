/**
 * The calls between the renderer and Electron's main process, as an Effect RPC group (`effect/rpc`), served over a
 * MessagePort (`electron/rpc`, `client.ts`). Inputs, outputs and errors are schemas: main decodes what the renderer
 * sends and the renderer decodes what main answers. Every call can fail with one of the user-facing errors
 * (`src/lib/errors.ts`), which arrive as those classes.
 *
 * Calls that report progress are streams: progress events, then one `Done` event with the result (`progress`). The
 * renderer's client turns them back into an iterator that yields the progress and returns the result.
 */
import { Schema } from "effect";
import { Rpc, RpcGroup } from "effect/rpc";

import * as Errors from "../errors";

/** Every failure a call can end with: the user-facing errors (`src/lib/errors.ts`). */
export const UserError = Schema.Union(
  Object.values(Errors).filter((value): value is (typeof Errors)[keyof typeof Errors] => Schema.isSchema(value)),
);

/** A call's progress events, then its result. */
export function progress<P extends Schema.Top, R extends Schema.Top>(event: P, result: R) {
  return Schema.Union([Schema.TaggedStruct("Progress", { progress: event }), Schema.TaggedStruct("Done", { result })]);
}

export const OpenedProject = Schema.Struct({ id: Schema.String, path: Schema.String });

export const ToolName = Schema.Literals(["yt-dlp", "quickjs", "ffmpeg"]);

export const ToolStatus = Schema.Struct({
  tool: ToolName,
  version: Schema.NullOr(Schema.String),
  checkedAt: Schema.NullOr(Schema.Number),
});

export const ToolProgress = Schema.Struct({
  tool: ToolName,
  phase: Schema.Literals(["checking", "downloading", "verifying", "installing"]),
  received: Schema.optional(Schema.Number),
  total: Schema.optional(Schema.NullOr(Schema.Number)),
});

export class NativeRpcs extends RpcGroup.make(
  Rpc.make("project.open", {
    payload: { path: Schema.String },
    success: OpenedProject,
    error: UserError,
  }),
  Rpc.make("tools.prepare", {
    payload: {
      tools: Schema.Array(ToolName),
      /** Check for newer versions even if the last check was recent. */
      force: Schema.optional(Schema.Boolean),
    },
    success: progress(ToolProgress, Schema.Array(ToolStatus)),
    error: UserError,
    stream: true,
  }),
) {}

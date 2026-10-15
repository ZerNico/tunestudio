import { ORPCError } from "@orpc/client";
import { Schema } from "effect";

import { UserError } from "./rpcs";

const isUserError = Schema.is(UserError);

/**
 * The message to show for a failed native call. Failures the user can act on carry a message written for them (one
 * of the classes in `src/lib/errors.ts`, or BAD_REQUEST from calls still on oRPC); anything else is a bug, described
 * generically.
 */
export function errorMessage(error: unknown): string {
  if (isUserError(error)) return error.message;
  if (error instanceof ORPCError && error.code === "BAD_REQUEST" && error.message) return error.message;
  return "Something went wrong. The details are in the log file.";
}

/** Whether the call was aborted (the user cancelled it). */
export function isAbort(error: unknown): boolean {
  return (
    (error instanceof DOMException && error.name === "AbortError") ||
    (error instanceof Error && error.name === "AbortError")
  );
}

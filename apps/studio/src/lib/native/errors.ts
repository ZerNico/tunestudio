import { ORPCError } from "@orpc/client";

/**
 * The message to show for a failed native call. Main sends failures the user can act on as
 * BAD_REQUEST with a message written for them; anything else is a bug, described generically.
 */
export function errorMessage(error: unknown): string {
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

import { Effect, Predicate } from "effect";
import type { PlatformError } from "effect/PlatformError";

import { DiskFull, FileNotFound, FileSystemFailure, PermissionDenied } from "../src/lib/errors";

// The error classes are shared with the renderer (`src/lib/errors.ts`); main keeps importing them from here.
export * from "../src/lib/errors";

/** Every file failure a user can act on. */
export type FileError = FileNotFound | PermissionDenied | DiskFull | FileSystemFailure;

const DISK_FULL = /ENOSPC|EDQUOT|SQLITE_FULL|disk is full|no space left/i;

function describeCause(error: unknown): string {
  if (error instanceof Error) return `${error.message} ${describeCause((error as { cause?: unknown }).cause ?? "")}`;
  if (error && typeof error === "object" && "code" in error) return String(error.code);
  return String(error ?? "");
}

/** Whether `error` (or its cause chain) says the disk is full. */
export function isDiskFull(error: unknown): boolean {
  return DISK_FULL.test(describeCause(error));
}

/**
 * Turns a file system failure into a message about `what` (e.g. `“song.txt”`) while
 * `doing` it (e.g. "read"), keeping the cases a user can fix apart.
 */
export function fileError(what: string, doing: string) {
  return (error: PlatformError): FileError => {
    const reason = error.reason;
    if (isDiskFull(error)) {
      return new DiskFull({ message: `There isn't enough free disk space to ${doing} ${what}.` });
    }
    if (Predicate.isTagged(reason, "NotFound"))
      return new FileNotFound({ message: `${capitalize(what)} doesn't exist anymore.` });
    if (Predicate.isTagged(reason, "PermissionDenied")) {
      return new PermissionDenied({
        message: `Tune Studio isn't allowed to ${doing} ${what}. Check the file's permissions, or choose another location.`,
      });
    }
    return new FileSystemFailure({ message: `Couldn't ${doing} ${what}: ${error.message}` });
  };
}

/** `Effect.mapError(fileError(...))` for an Effect that only fails with a `PlatformError`. */
export function mapFileError(what: string, doing: string) {
  return <A, R>(effect: Effect.Effect<A, PlatformError, R>) => Effect.mapError(effect, fileError(what, doing));
}

function capitalize(text: string): string {
  return text.charAt(0).toUpperCase() + text.slice(1);
}

/** “Song.txt”, for messages. */
export function quoted(name: string): string {
  return `“${name}”`;
}

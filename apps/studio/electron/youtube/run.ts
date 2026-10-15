import { Effect, Stream } from "effect";
import { ChildProcess, ChildProcessSpawner } from "effect/process";

/** How a tool run ended: its exit code and everything it wrote to stderr. */
export interface RunResult {
  readonly code: number;
  readonly stderr: string;
}

/**
 * Runs `command` with `args` (no shell), calling `onLine` for each line it prints on stdout.
 * Interrupting the effect kills the process. Fails only if the program can't be started.
 */
export function runTool(
  command: string,
  args: readonly string[],
  onLine: (line: string) => Effect.Effect<void> = () => Effect.void,
): Effect.Effect<RunResult, string, ChildProcessSpawner.ChildProcessSpawner> {
  return Effect.scoped(
    Effect.gen(function* () {
      const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
      const handle = yield* spawner.spawn(ChildProcess.make(command, [...args], { windowsHide: true }));
      const [, stderr] = yield* Effect.all(
        [
          handle.stdout.pipe(Stream.decodeText(), Stream.splitLines, Stream.runForEach(onLine)),
          handle.stderr.pipe(Stream.decodeText(), Stream.mkString),
        ],
        { concurrency: "unbounded" },
      );
      const code = yield* handle.exitCode;
      return { code: Number(code), stderr };
    }),
  ).pipe(Effect.mapError((error) => error.message));
}

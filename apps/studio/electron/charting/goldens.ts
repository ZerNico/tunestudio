/**
 * Test helper: the Python pipeline's recorded stage calls for real songs (`tst goldens` in `training/`), so each
 * ported function can be checked against it on real data. They contain song lyrics, so they stay out of the
 * repository: tests that use them run only when TUNESTUDIO_CHART_GOLDENS points at the goldens folder.
 */
import fs from "node:fs";
import path from "node:path";
import { gunzipSync } from "node:zlib";

export const GOLDENS = process.env.TUNESTUDIO_CHART_GOLDENS;

/** One recorded call: arguments as passed, the result, and changed-in-place arguments afterwards. */
export interface Call {
  fn: string;
  args: unknown[];
  kwargs: Record<string, unknown>;
  result: unknown;
  args_after?: unknown[];
}

export interface Golden {
  song: string;
  calls: Call[];
}

const TYPED = {
  float64: Float64Array,
  float32: Float32Array,
  int64: BigInt64Array,
  int32: Int32Array,
  bool: Uint8Array,
} as const;

/** The songs with recorded goldens (none without TUNESTUDIO_CHART_GOLDENS). */
export function goldenSongs(): string[] {
  if (!GOLDENS) return [];
  return fs.readdirSync(GOLDENS).filter((name) => fs.existsSync(path.join(GOLDENS, name, "calls.json.gz")));
}

/** A song's recorded calls, with arrays as typed arrays and NaN/infinities as numbers. */
export function loadGolden(song: string): Golden {
  const folder = path.join(GOLDENS!, song);
  const arrays = new Map<string, ArrayLike<number> | BigInt64Array>();
  const array = (key: string) => {
    let found = arrays.get(key);
    if (!found) {
      const dtype = key.split("-")[0] as keyof typeof TYPED;
      const bytes = fs.readFileSync(path.join(folder, "arrays", `${key}.bin`));
      const Typed = TYPED[dtype];
      found = new Typed(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength));
      arrays.set(key, found);
    }
    return found;
  };
  const raw = gunzipSync(fs.readFileSync(path.join(folder, "calls.json.gz"))).toString("utf8");
  return JSON.parse(raw, (_, value: unknown) => {
    if (value && typeof value === "object" && !Array.isArray(value)) {
      const v = value as Record<string, unknown>;
      if (typeof v.$array === "string") return array(v.$array);
      if (typeof v.$float === "string") return { nan: Number.NaN, inf: Infinity, "-inf": -Infinity }[v.$float];
      if (Array.isArray(v.$set)) return v.$set;
    }
    return value;
  }) as Golden;
}

/** The recorded calls of one function, e.g. "autotuner.boundary.assign". */
export function callsOf(golden: Golden, fn: string): Call[] {
  return golden.calls.filter((call) => call.fn === fn);
}

/**
 * A named float32 array of a song's golden (arrays.json): "track.midi", "track.rms", "audio.vocals16k" (the vocals at
 * 16 kHz), "audio.mix22k" (the song at 22.05 kHz); null when the golden doesn't have it.
 */
export function namedArray(song: string, name: string): Float32Array | null {
  const named = JSON.parse(fs.readFileSync(path.join(GOLDENS!, song, "arrays.json"), "utf8")) as Record<string, string>;
  const key = named[name];
  if (!key) return null;
  const bytes = fs.readFileSync(path.join(GOLDENS!, song, "arrays", `${key}.bin`));
  return new Float32Array(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength));
}

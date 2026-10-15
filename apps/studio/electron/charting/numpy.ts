/**
 * Python and NumPy arithmetic the chart pipeline depends on, reproduced exactly where the PoC's decisions hinge on
 * it: `round()` rounds halves to even, `%` is floor modulo, NumPy sums floats pairwise, `np.arange` steps by the
 * difference of its first two values. Never use `Math.round` or `%` in the chart port; use these.
 */

/** Python's `round(x)` / NumPy's `np.round(x)`: nearest integer, halves to the even one. */
export function pyRound(x: number): number {
  const floor = Math.floor(x);
  const fraction = x - floor;
  if (fraction < 0.5) return floor;
  if (fraction > 0.5) return floor + 1;
  return floor % 2 === 0 ? floor : floor + 1;
}

/** Python's `a % b` for floats and ints: the result has the sign of `b` (CPython's float_rem). */
export function floorMod(a: number, b: number): number {
  let r = a % b;
  if (r !== 0) {
    if (r < 0 !== b < 0) r += b;
  } else {
    r = b < 0 ? -0 : 0;
  }
  return r;
}

const BLOCK = 128;

const same = (x: number) => x;

/** NumPy's pairwise summation (`pairwise_sum` in its loops), the order `np.sum` and `np.mean` add in. */
export function pairwiseSum(
  values: ArrayLike<number>,
  start = 0,
  count = values.length - start,
  round: (x: number) => number = same,
): number {
  // `round` is Math.fround for float32 arrays, whose sums NumPy keeps in float32.
  const add = (a: number, b: number) => round(a + b);
  if (count < 8) {
    let sum = -0;
    for (let i = start; i < start + count; i++) sum = add(sum, values[i]!);
    return sum;
  }
  if (count <= BLOCK) {
    const r = [0, 1, 2, 3, 4, 5, 6, 7].map((k) => values[start + k]!);
    let i = 8;
    for (; i < count - (count % 8); i += 8) {
      for (let k = 0; k < 8; k++) r[k] = add(r[k]!, values[start + i + k]!);
    }
    let sum = add(add(add(r[0]!, r[1]!), add(r[2]!, r[3]!)), add(add(r[4]!, r[5]!), add(r[6]!, r[7]!)));
    for (; i < count; i++) sum = add(sum, values[start + i]!);
    return sum;
  }
  let half = Math.floor(count / 2);
  half -= half % 8;
  return add(pairwiseSum(values, start, half, round), pairwiseSum(values, start + half, count - half, round));
}

/**
 * NumPy's pairwise sum of complex values given as interleaved [re, im, re, im, ...] (CDOUBLE_pairwise_sum): the
 * real and imaginary parts are each summed in the same blocked order. Returns [re, im].
 */
export function pairwiseSumComplex(
  values: ArrayLike<number>,
  start = 0,
  count = values.length - start,
  round: (x: number) => number = same,
): [number, number] {
  // `count` counts the floats (twice the complex values), as NumPy's loop does. `round` is Math.fround for
  // complex64, whose sums NumPy keeps in float32.
  const add = (a: number, b: number) => round(a + b);
  if (count < 8) {
    let re = -0;
    let im = -0;
    for (let i = start; i < start + count; i += 2) {
      re = add(re, values[i]!);
      im = add(im, values[i + 1]!);
    }
    return [re, im];
  }
  if (count <= BLOCK) {
    const r = [0, 1, 2, 3, 4, 5, 6, 7].map((k) => values[start + k]!);
    let i = 8;
    for (; i < count - (count % 8); i += 8) {
      for (let k = 0; k < 8; k++) r[k] = add(r[k]!, values[start + i + k]!);
    }
    let re = add(add(r[0]!, r[2]!), add(r[4]!, r[6]!));
    let im = add(add(r[1]!, r[3]!), add(r[5]!, r[7]!));
    for (; i < count; i += 2) {
      re = add(re, values[start + i]!);
      im = add(im, values[start + i + 1]!);
    }
    return [re, im];
  }
  let half = Math.floor(count / 2);
  half -= half % 8;
  const [re1, im1] = pairwiseSumComplex(values, start, half, round);
  const [re2, im2] = pairwiseSumComplex(values, start + half, count - half, round);
  return [add(re1, re2), add(im1, im2)];
}

/**
 * `np.mean` of complex values given interleaved: the pairwise sum divided the way NumPy divides complex numbers
 * (CDOUBLE_divide multiplies by the reciprocal `1 / (n + 0j)`, which can differ from `/ n` in the last bit).
 */
export function complexMean(values: ArrayLike<number>): [number, number] {
  const [re, im] = pairwiseSumComplex(values);
  const scale = 1 / (values.length / 2);
  return [re * scale, im * scale];
}

/** `complexMean` for complex64 (float32 parts and arithmetic, as NumPy keeps them). */
export function complexMean32(values: ArrayLike<number>): [number, number] {
  const [re, im] = pairwiseSumComplex(values, 0, values.length, Math.fround);
  const scale = Math.fround(1 / Math.fround(values.length / 2));
  return [Math.fround(re * scale), Math.fround(im * scale)];
}

/** `np.mean` of float64 values. */
export function mean(values: ArrayLike<number>): number {
  return pairwiseSum(values) / values.length;
}

/** `np.std` (population, ddof 0) of float64 values. */
export function std(values: ArrayLike<number>): number {
  const m = mean(values);
  const squares = Array.from(values, (v) => (v - m) * (v - m));
  return Math.sqrt(pairwiseSum(squares) / values.length);
}

/** `np.median`: the middle value, or the mean of the two middle ones (NaN for none). */
export function median(values: ArrayLike<number>): number {
  const sorted = Float64Array.from(values).toSorted();
  const n = sorted.length;
  if (n === 0) return Number.NaN;
  const mid = Math.floor(n / 2);
  return n % 2 === 1 ? sorted[mid]! : (sorted[mid - 1]! + sorted[mid]!) / 2;
}

/** `np.percentile(values, q)` with NumPy's default linear interpolation (and its `_lerp` rounding). */
export function percentile(values: ArrayLike<number>, q: number): number {
  const sorted = Float64Array.from(values).toSorted();
  const n = sorted.length;
  if (n === 0) return Number.NaN;
  const index = (n - 1) * (q / 100); // NumPy divides q by 100 first
  const lo = Math.floor(index);
  const hi = Math.min(lo + 1, n - 1);
  const t = index - lo;
  const a = sorted[lo]!;
  const b = sorted[hi]!;
  const diff = b - a;
  return t >= 0.5 ? b - diff * (1 - t) : a + diff * t;
}

/** `np.argmax`: the index of the first largest value (NaN counts as largest, as in NumPy). */
export function argmax(values: ArrayLike<number>): number {
  let best = 0;
  for (let i = 0; i < values.length; i++) {
    const v = values[i]!;
    if (Number.isNaN(v)) return i;
    if (v > values[best]!) best = i;
  }
  return best;
}

/**
 * `np.arange(start, stop, step)` for floats: `ceil((stop - start) / step)` values; the second is `start + step`,
 * the rest `start + i * delta` with `delta` the difference of the first two (NumPy's DOUBLE_fill), not `step`.
 */
export function arange(start: number, stop: number, step: number): Float64Array {
  const length = Math.max(0, Math.ceil((stop - start) / step));
  const out = new Float64Array(length);
  if (length > 0) out[0] = start;
  if (length > 1) out[1] = start + step;
  const delta = out[1]! - start;
  for (let i = 2; i < length; i++) out[i] = start + i * delta;
  return out;
}

/** `np.mean` of a float32 array (summed and divided in float32). */
export function mean32(values: ArrayLike<number>): number {
  return Math.fround(pairwiseSum(values, 0, values.length, Math.fround) / values.length);
}

/** `np.std` of a float32 array (ddof 0, all in float32). */
export function std32(values: ArrayLike<number>): number {
  const m = mean32(values);
  const squares = Array.from(values, (v) => {
    const d = Math.fround(v - m);
    return Math.fround(d * d);
  });
  return Math.fround(Math.sqrt(Math.fround(pairwiseSum(squares, 0, squares.length, Math.fround) / values.length)));
}

/** `np.median` of a float32 array (the two middle values averaged in float32). */
export function median32(values: ArrayLike<number>): number {
  const sorted = Float64Array.from(values).toSorted();
  const n = sorted.length;
  if (n === 0) return Number.NaN;
  const mid = Math.floor(n / 2);
  return n % 2 === 1 ? sorted[mid]! : Math.fround(Math.fround(sorted[mid - 1]! + sorted[mid]!) / 2);
}

/** `np.percentile` of a float32 array: with a Python number as `q`, NumPy keeps the interpolation in float32. */
export function percentile32(values: ArrayLike<number>, q: number): number {
  const sorted = Float64Array.from(values).toSorted();
  const n = sorted.length;
  if (n === 0) return Number.NaN;
  const index = (n - 1) * (q / 100); // NumPy divides q by 100 first
  const lo = Math.floor(index);
  const hi = Math.min(lo + 1, n - 1);
  const t = index - lo;
  const a = sorted[lo]!;
  const b = sorted[hi]!;
  const diff = Math.fround(b - a);
  // The weight is a Python float there, so NumPy casts it (and 1 − weight) to float32 before multiplying.
  return t >= 0.5
    ? Math.fround(b - Math.fround(diff * Math.fround(1 - t)))
    : Math.fround(a + Math.fround(diff * Math.fround(t)));
}

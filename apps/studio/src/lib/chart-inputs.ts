/**
 * What a chart is made from, as a key: the lyrics lines (text and line times, which the alignment cross-checks) and
 * the language. A chart made for one key is out of date once the lyrics or language change; the song's name and
 * cover don't matter. Shared by the renderer (is the made chart still current?) and main (is it still right to save?).
 */
export function chartInputsKey(
  lines: readonly { start: number | null; text: string }[] | null | undefined,
  language: string | null,
): string {
  return JSON.stringify([language, (lines ?? []).map((line) => [line.text.trim(), line.start])]);
}

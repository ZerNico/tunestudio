/**
 * The typographer's apostrophe (’) for the look-alikes lyrics come with: the grave (`) and acute (´) accents, the
 * prime (′), the left quotation mark (‘) and the typewriter apostrophe ('); two typewriter ones ('') are a double
 * quote. As usdb_syncer corrects them on download (`replace_false_apostrophes`), so a chart reads the same before.
 */
export function fixApostrophes(text: string): string {
  return text.replaceAll("''", '"').replace(/[`´′‘']/gu, "’");
}

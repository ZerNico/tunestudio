import { createId, type ChartDocument } from "./types";

/** A chart with no notes and valid default headers, for new projects and tests. */
export function createEmptyDocument(): ChartDocument {
  return {
    version: 1,
    id: createId("chart"),
    metadata: { TITLE: "Untitled", ARTIST: "Unknown artist", BPM: "120", GAP: "0" },
    notes: [],
  };
}

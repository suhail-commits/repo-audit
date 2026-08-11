import type { Confidence } from "./types";

/**
 * Plain-English band for a provenance score.
 *
 * Lives in shared because both the engine (CLI output) and the rules package
 * (report prose) need the same thresholds — two copies would drift.
 */
export type ProvenanceBand = "unlikely" | "possible" | "likely" | "near-certain";

/**
 * The bands as a scale, lowest first, with the score each one starts at.
 *
 * Exported so the report can *draw* the scale instead of restating these
 * numbers in a component. A reader shown "15 / 100" with no scale cannot tell
 * whether high means more AI or less, or whether 15 is normal.
 */
export const PROVENANCE_BANDS: readonly {
  band: ProvenanceBand;
  /** Inclusive lower bound, 0-100. */
  from: number;
  label: string;
}[] = [
  { band: "unlikely", from: 0, label: "unlikely" },
  { band: "possible", from: 30, label: "possible" },
  { band: "likely", from: 50, label: "likely" },
  { band: "near-certain", from: 75, label: "near certain" },
];

export function provenanceBand(score: number): ProvenanceBand {
  if (score >= 75) return "near-certain";
  if (score >= 50) return "likely";
  if (score >= 30) return "possible";
  return "unlikely";
}

/** How a confidence level should be described to a reader. */
export function confidencePhrase(confidence: Confidence): string {
  switch (confidence) {
    case "certain":
      return "This is documented in the project itself, not inferred";
    case "high":
      return "Nearly all the usual evidence was available";
    case "medium":
      return "Some evidence was unavailable, so treat this as indicative";
    case "low":
      return "Much of the usual evidence was missing, so this is a weak read";
  }
}

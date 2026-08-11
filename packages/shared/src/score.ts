import type { Confidence } from "./types";

/**
 * Plain-English band for a provenance score.
 *
 * Lives in shared because both the engine (CLI output) and the rules package
 * (report prose) need the same thresholds — two copies would drift.
 */
export type ProvenanceBand = "unlikely" | "possible" | "likely" | "near-certain";

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

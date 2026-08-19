import type { Confidence, Signal } from "./types";

/**
 * Plain-English band for an authorship score.
 *
 * Lives in shared because both the engine (CLI output) and the rules package
 * (report prose) need the same thresholds — two copies would drift.
 */
export type AuthorshipBand = "unlikely" | "possible" | "likely" | "near-certain";

/**
 * The bands as a scale, lowest first, with the score each one starts at.
 *
 * Exported so the report can *draw* the scale instead of restating these
 * numbers in a component. A reader shown "15 / 100" with no scale cannot tell
 * whether high means more AI or less, or whether 15 is normal.
 */
export const AUTHORSHIP_BANDS: readonly {
  band: AuthorshipBand;
  /** Inclusive lower bound, 0-100. */
  from: number;
  label: string;
}[] = [
  { band: "unlikely", from: 0, label: "unlikely" },
  { band: "possible", from: 30, label: "possible" },
  { band: "likely", from: 50, label: "likely" },
  { band: "near-certain", from: 75, label: "near certain" },
];

export function authorshipBand(score: number): AuthorshipBand {
  if (score >= 75) return "near-certain";
  if (score >= 50) return "likely";
  if (score >= 30) return "possible";
  return "unlikely";
}

/**
 * Plain-English band for a code-health score.
 *
 * **Higher means more problems, the same direction as authorship**, because
 * every signal value is a measure of how much of the bad thing was found. The
 * alternative — inverting so 85 reads as "healthy" — would make the breakdown
 * bars sum to `100 − score`, and the bars summing to the number is the whole
 * argument that this tool measures rather than guesses.
 *
 * The band words carry the direction instead, which is why they are adjectives
 * about the codebase rather than about likelihood.
 */
export type HealthBand = "solid" | "minor-issues" | "rough" | "poor";

export const HEALTH_BANDS: readonly {
  band: HealthBand;
  from: number;
  label: string;
}[] = [
  { band: "solid", from: 0, label: "solid" },
  { band: "minor-issues", from: 25, label: "minor issues" },
  { band: "rough", from: 50, label: "rough" },
  { band: "poor", from: 75, label: "poor" },
];

export function healthBand(score: number): HealthBand {
  if (score >= 75) return "poor";
  if (score >= 50) return "rough";
  if (score >= 25) return "minor-issues";
  return "solid";
}

/** The scale a dimension is drawn on, or none if it does not carry a score. */
export type SecurityBand = "none" | "some" | "several" | "widespread";

/**
 * How much exposure was found — a quantity, never a verdict.
 *
 * The wording is the careful part. Security signals are presence-shaped, so a
 * single committed credential saturates one check out of five and lands the
 * score around twenty. Borrowing the health words would print **"solid"** on
 * the same screen as a live AWS key, and the authorship words — which this
 * dimension used by default — printed **"21 out of 100 — unlikely"**, which
 * answers a question nobody asked.
 *
 * So these label the *amount measured* and leave the judgement to the headline,
 * which is taken from the worst finding precisely because the number cannot
 * carry it. "some" above a critical finding is a statement about how much was
 * found, and does not contradict "this needs fixing today".
 */
export const SECURITY_BANDS: readonly {
  band: SecurityBand;
  from: number;
  label: string;
}[] = [
  { band: "none", from: 0, label: "nothing found" },
  { band: "some", from: 15, label: "some" },
  { band: "several", from: 40, label: "several" },
  { band: "widespread", from: 70, label: "widespread" },
];

export function bandsFor(
  dimension: string,
): readonly { from: number; label: string }[] {
  if (dimension === "health") return HEALTH_BANDS;
  if (dimension === "security") return SECURITY_BANDS;
  return AUTHORSHIP_BANDS;
}

/** One signal's share of a dimension's score, in points out of 100. */
export interface SignalContribution {
  signal: Signal;
  /** What this signal actually contributed. Zero when unavailable. */
  points: number;
  /** What it *could* have contributed at value 1.0 — its share of the weight. */
  maxPoints: number;
}

/**
 * Split a dimension's score into per-signal points that sum back to it.
 *
 * The arithmetic is the report's central argument — "here is the number, and
 * here is it adding up" — so it lives in one place rather than beside each
 * surface that prints it. The web breakdown and the CLI both read this; two
 * copies would let the same repository print two different numbers, which is
 * the failure `analyzeHealth` already avoids by borrowing authorship's
 * `Signal` objects instead of measuring again.
 *
 * Weight is normalised over *available* signals only, which is invariant 2
 * expressed as arithmetic: an unavailable signal contributes nothing and its
 * weight is redistributed, rather than counting as a zero.
 */
export function contributions(signals: readonly Signal[]): SignalContribution[] {
  const totalWeight = signals
    .filter((s) => s.available)
    .reduce((sum, s) => sum + s.weight, 0);

  return signals.map((signal) => {
    const maxPoints = totalWeight > 0 ? (signal.weight / totalWeight) * 100 : 0;
    return {
      signal,
      points: signal.available ? maxPoints * signal.value : 0,
      maxPoints,
    };
  });
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

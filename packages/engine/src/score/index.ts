import type { Confidence, Dimension, DimensionScore, Signal } from "@vibe/shared";

/**
 * How strong a ground-truth signal must be before the dimension reports
 * `certain`. Matches the point at which `agent-trailers` stops scaling and
 * starts saturating, so the two thresholds cannot drift apart.
 */
export const GROUND_TRUTH_THRESHOLD = 0.6;

export interface ScoreOptions {
  /**
   * Signals whose firing is ground truth rather than inference. When one of these
   * fires, the dimension reports `certain` confidence regardless of coverage.
   */
  groundTruthSignals?: string[];
}

/**
 * Combine signals into a 0-100 dimension score.
 *
 * Unavailable signals are excluded and their weight redistributed across the rest,
 * rather than contributing zero. This matters more than it looks: treating a
 * missing signal as a zero would make a zip upload with no git history score as
 * *cleaner* than the same repo scanned from GitHub, which is exactly backwards.
 * Coverage is reported as confidence instead.
 */
export function scoreDimension(
  dimension: Dimension,
  signals: Signal[],
  options: ScoreOptions = {},
): DimensionScore {
  const groundTruth = new Set(options.groundTruthSignals ?? []);

  const available = signals.filter((s) => s.available);
  const totalWeight = signals.reduce((sum, s) => sum + s.weight, 0);
  const availableWeight = available.reduce((sum, s) => sum + s.weight, 0);

  const score =
    availableWeight === 0
      ? 0
      : Math.round(
          (available.reduce((sum, s) => sum + s.value * s.weight, 0) /
            availableWeight) *
            100,
        );

  // A ground-truth signal must be *materially* present to claim certainty, not
  // merely nonzero. Ten agent-attributed commits in a 2,612-commit history is
  // direct evidence that agents touched the repo — it is not evidence that the
  // repo is agent-written, and reporting `certain` off it overstates the claim.
  const groundTruthFired = available.some(
    (s) => groundTruth.has(s.id) && s.value >= GROUND_TRUTH_THRESHOLD,
  );

  const coverage = totalWeight === 0 ? 0 : availableWeight / totalWeight;
  let confidence: Confidence;
  if (groundTruthFired) confidence = "certain";
  else if (coverage >= 0.8) confidence = "high";
  else if (coverage >= 0.5) confidence = "medium";
  else confidence = "low";

  const unavailable = signals
    .filter((s) => !s.available)
    .map((s) => s.unavailableReason ?? `${s.id} unavailable`);

  return { dimension, score, confidence, signals, unavailable };
}

// Band thresholds live in @vibe/shared so the CLI and the report prose agree.
export { provenanceBand, type ProvenanceBand } from "@vibe/shared";

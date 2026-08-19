import type { Confidence, Dimension, DimensionScore, Signal } from "@vibe/shared";

import { computeHotspots } from "./hotspots";

export interface ScoreOptions {
  /**
   * Signals whose firing is ground truth rather than inference.
   *
   * Retained so callers can identify them (calibration disables them), but they
   * no longer alter confidence — see below.
   */
  groundTruthSignals?: string[];
  /**
   * Every source file in the repository, repo-relative.
   *
   * Needed to rank directories by *density* rather than volume — without the
   * denominators, a big directory outranks a bad one. Omit it and the score is
   * computed exactly as before with no hotspots.
   */
  sourceFiles?: string[];
  /**
   * The repository was too large to read in full.
   *
   * **The largest missing input there is, and for a long time it did not reach
   * the score at all.** `FileIndex.truncated` produced a warning string and
   * nothing else, so a repository where a fifth of the files were read reported
   * the same confidence as one read completely — every signal "available",
   * coverage 100%, `high`.
   *
   * It caps confidence rather than scaling it, because the honest quantity is
   * unknown: the walk stops when a cap is hit, so we never learn how many files
   * were left. A ratio would be a fabricated denominator. What we can say
   * truthfully is that we do not know how much we missed, and `low` is the
   * word for that.
   */
  truncated?: boolean;
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

  /*
   * Confidence answers exactly one question: how much of the evidence could we
   * actually gather? It is coverage, nothing else.
   *
   * A ground-truth signal used to force this to `certain`, which conflated two
   * different claims. Finding a committed `CLAUDE.md` makes us certain *that a
   * file exists*; it says nothing about how confident we are in the resulting
   * number. `colinhacks/zod` demonstrated the incoherence — it reported
   * "27/100, certain confidence" and narrated "this mostly looks like
   * hand-written code" directly above "Cursor: .cursorrules present". The 27 was
   * right; the certainty was not.
   *
   * Ground truth still raises the *score*, which is what it is evidence for.
   *
   * The dimension never claims `certain`, so the invariant that `certain` is
   * reserved for ground truth is preserved where it belongs: on individual
   * findings, where "this file is present" genuinely is certain.
   */
  const coverage = totalWeight === 0 ? 0 : availableWeight / totalWeight;
  let confidence: Confidence;
  if (coverage >= 0.8) confidence = "high";
  else if (coverage >= 0.5) confidence = "medium";
  else confidence = "low";

  /*
   * Signal coverage measures how many *checks* ran. It says nothing about how
   * much of the repository they ran over, and on a truncated scan those are
   * very different numbers — every signal reports available because each one
   * genuinely ran, over a fraction of the files.
   */
  if (options.truncated) confidence = "low";

  const unavailable = signals
    .filter((s) => !s.available)
    .map((s) => s.unavailableReason ?? `${s.id} unavailable`);

  if (options.truncated) {
    unavailable.push(
      "the repository was too large to read in full, so every check below ran " +
        "over part of it",
    );
  }

  const hotspots = options.sourceFiles
    ? computeHotspots(signals, { sourceFiles: options.sourceFiles })
    : [];

  return { dimension, score, confidence, signals, unavailable, hotspots };
}

// Band thresholds live in @vibe/shared so the CLI and the report prose agree.
export { authorshipBand, type AuthorshipBand } from "@vibe/shared";
export { computeHotspots, directoryOf } from "./hotspots";

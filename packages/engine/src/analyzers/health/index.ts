import type { DimensionScore, Signal } from "@vibe/shared";

import { scoreDimension } from "../../score/index";
import { ramp, unavailable, type AnalysisContext } from "../context";

/**
 * Is this codebase in good shape?
 *
 * Six of these signals are the *same measurements* the authorship dimension
 * reads — duplication, dead code, comment narration, test tautology — because
 * one measurement genuinely answers two questions. Duplicated logic is evidence
 * that a tool wrote the code *and* work someone has to do. The authorship
 * section presents them as evidence; this one presents them as defects.
 *
 * **They are re-weighted, not recomputed.** The signal objects are handed in
 * from the authorship pass and only their weights are replaced. Recomputing
 * would double the cost of the expensive ones (clone hashing walks every
 * function) and, worse, would let the same measurement print two different
 * numbers in two sections if either implementation ever drifted.
 *
 * Score direction matches authorship: **higher means more problems found**.
 * Every signal value is "how much of the bad thing is present", so the bars in
 * the breakdown sum to the score. See `HEALTH_BANDS` for why that mattered more
 * than the score reading like a grade.
 */

/**
 * What each signal is worth *to this question*, which is not what it is worth
 * to authorship.
 *
 * Duplication is the clearest example: for authorship it is one tell among
 * many, but for health it is the single most expensive thing on the list —
 * every future change to that logic has to be made more than once.
 */
export const WEIGHTS = {
  "duplicate-logic": 3,
  "orphan-files": 2,
  "tautological-tests": 2,
  "unused-dependencies": 1.5,
  "obvious-comments": 1,
  "overlapping-utils": 1,
  "test-coverage": 2.5,
} as const;

/** The signals health borrows from the authorship pass, by id. */
export const SHARED_SIGNAL_IDS = [
  "duplicate-logic",
  "orphan-files",
  "tautological-tests",
  "unused-dependencies",
  "obvious-comments",
  "overlapping-utils",
] as const;

export interface HealthResult {
  score: DimensionScore;
}

export function analyzeHealth(
  ctx: AnalysisContext,
  sharedSignals: Signal[],
): HealthResult {
  const borrowed = SHARED_SIGNAL_IDS.map((id) => {
    const signal = sharedSignals.find((s) => s.id === id);
    /*
     * A missing signal here would mean the authorship pass stopped emitting it.
     * Reporting it unavailable rather than dropping it keeps the weight
     * redistribution honest — a silently shorter list would quietly raise every
     * other signal's share.
     */
    if (!signal) {
      return unavailable(id, WEIGHTS[id], "not produced by this scan");
    }
    return { ...signal, weight: WEIGHTS[id] };
  });

  const signals: Signal[] = [...borrowed, testCoverageSignal(ctx)];

  return { score: scoreDimension("health", signals) };
}

/**
 * How much of the codebase has tests at all.
 *
 * Deliberately a *file ratio*, not line coverage — line coverage cannot be
 * measured without running the suite, and this project never executes the code
 * it analyses. The report says which one this is, because a reader who assumes
 * "coverage" means the other thing has been misled by us rather than by their
 * own repository.
 *
 * A repository with no test files at all is the strong case. Beyond that the
 * ratio is soft: a well-tested project may keep one test file per module or one
 * per package, so the ramp is gentle and tops out well short of 1:1.
 */
function testCoverageSignal(ctx: AnalysisContext): Signal {
  const id = "test-coverage";
  const sourceFiles = ctx.files.sourceFiles().length;
  const testFiles = ctx.files.testFiles().length;

  // Below this there is no meaningful ratio — a four-file utility with no
  // separate test file is not evidence of anything.
  if (sourceFiles < 5) {
    return unavailable(id, WEIGHTS[id], "too few source files to judge");
  }

  const ratio = testFiles / sourceFiles;

  return {
    id,
    // Inverted: a *low* ratio is the finding, and every other signal in this
    // dimension reads "higher value means worse".
    value: 1 - ramp(ratio, 0.05, 0.4),
    weight: WEIGHTS[id],
    available: true,
    evidence:
      testFiles === 0
        ? [`No test files found across ${sourceFiles} source files`]
        : [
            `${testFiles} test ${testFiles === 1 ? "file" : "files"} for ${sourceFiles} source files ` +
              `(${Math.round(ratio * 100)}%) — counted by file, not by line: we never run the suite`,
          ],
  };
}

import type { Signal } from "@vibe/shared";

import { clamp01, unavailable, type AnalysisContext } from "../context";
import { percentile } from "./commit-shape";
import { countOf } from "../../format";

/**
 * Does anything ever get deleted here?
 *
 * GitClear's study of 211 million lines of change found that as AI assistants
 * spread, refactoring collapsed: "moved" lines fell from 24.1% of changes in
 * 2020 to 9.5% in 2024, and 2024 was the first year on record where
 * within-commit copy/paste exceeded moved code. Generated code accumulates.
 * Nobody goes back and tidies it, because nobody had to understand it to put it
 * there.
 *
 * **What is measured here is not GitClear's metric, and the naming has to keep
 * saying so.** Detecting a *move* needs patch text, which no history source
 * available to this project provides — the GitHub API gives per-commit totals
 * and nothing finer. What survives from commit totals is a cruder question with
 * the same shape: of everything a commit changed, how much of it was removal? A
 * commit that deletes 40 lines and adds 45 is someone reworking; one that adds
 * 300 and deletes 2 is someone piling on.
 *
 * ### Every threshold here came from measuring, not from judgement
 *
 * Across the 20 hand-written sweep repositories the median commit's deletion
 * share lands between **0.333 and 0.500**, clustered tightly — nine of the
 * twenty sit at 0.40–0.50. That is a remarkably stable property of code written
 * by people, and it is what makes the low end meaningful.
 *
 * ### The maturity guard is the whole reason this is safe
 *
 * **This repository reads 0.085**, far under the corpus floor — truthfully, and
 * not because it was generated. It is twenty commits across two days, and
 * nothing has yet had reason to be deleted. A project too young to have
 * refactored is a point, not a measurement, which is exactly the mistake
 * `build-velocity` made when it divided by a single active day. So a history
 * that has not had the opportunity reports unavailable rather than reporting
 * the truthful number as evidence of generation.
 *
 * Two sibling metrics from the same study were measured and **rejected**: early
 * rework varies 0.003–0.814 across hand-written repositories, and a cross-file
 * moved-lines estimator reads exactly 0.000 on all twenty. See *Investigated and
 * rejected* in `CLAUDE.md`.
 */

export const WEIGHT = 1.5;

/**
 * Below these, the project has not had the chance to delete anything.
 *
 * Both ends, deliberately. Commits alone would admit a repository with two
 * hundred commits in a weekend; days alone would admit one with four commits
 * spread over a year. The corpus clears both comfortably — the smallest,
 * `sindresorhus/p-limit`, has 79 commits across years.
 */
const MIN_COMMITS = 50;
const MIN_ACTIVE_DAYS = 14;

/**
 * Where the ramp starts and ends.
 *
 * `QUIET` sits below the corpus floor of 0.333 with room to spare rather than
 * hard against it — a hand-written repository that deletes a little less than
 * `jd/tenacity` should not immediately start scoring.
 */
const QUIET = 0.25;
const FULL = 0.05;

export function refactorRatioSignal(ctx: AnalysisContext): Signal {
  const id = "refactor-ratio";

  if (!ctx.git.available) {
    return unavailable(
      id,
      WEIGHT,
      ctx.git.unavailableReason ?? "git history unavailable",
    );
  }

  const commits = ctx.git.commits;
  if (commits.length < MIN_COMMITS) {
    return unavailable(
      id,
      WEIGHT,
      `only ${countOf(commits.length, "commit")} — too short a history to have refactored anything`,
    );
  }

  const activeDays = ctx.git.activeDays();
  if (activeDays < MIN_ACTIVE_DAYS) {
    return unavailable(
      id,
      WEIGHT,
      `only ${countOf(activeDays, "active day")} — a project this young has had no occasion to delete code`,
    );
  }

  /*
   * `churn` is added + deleted and `linesAdded` is the added half, so the
   * difference is the deleted half. Both survive the GitHub GraphQL path; the
   * unauthenticated REST path returns neither, which is why this checks for an
   * empty set rather than assuming the counts are there — the same distinction
   * `commit-size` draws between "no sizeable commits" and "this source does not
   * report line counts".
   */
  const shares = commits
    .filter((c) => c.churn > 0)
    .map((c) => (c.churn - c.linesAdded) / c.churn);

  if (shares.length < MIN_COMMITS) {
    return unavailable(
      id,
      WEIGHT,
      shares.length === 0
        ? "commit line counts are unavailable from this history source"
        : "too few commits with line counts",
    );
  }

  const share = percentile(shares, 0.5);

  return {
    id,
    // Inverted: a high deletion share is the *healthy*, human end, so the value
    // — which always means "more of the thing we are detecting" — rises as the
    // share falls.
    value: clamp01((QUIET - share) / (QUIET - FULL)),
    weight: WEIGHT,
    available: true,
    evidence: [
      `Deletions are ${Math.round(share * 100)}% of what the median commit changes ` +
        `(hand-written repositories measure 33-50%)`,
      `Measured across ${shares.length} commits spanning ${activeDays} active days`,
    ],
  };
}

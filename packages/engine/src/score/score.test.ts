import type { Signal } from "@vibe/shared";
import { describe, expect, it } from "vitest";

import { trailerValue } from "../analyzers/authorship/trailers";
import { scoreDimension } from "./index";

function signal(partial: Partial<Signal> & { id: string }): Signal {
  return {
    value: 0,
    weight: 1,
    available: true,
    evidence: [],
    ...partial,
  };
}

describe("agent trailer proportionality", () => {
  it("scores a handful of agent commits in a long history as near-zero", () => {
    // colinhacks/zod: 10 agent-attributed commits out of 2,612 from drive-by
    // contributors. This used to saturate at 0.6 and drag the repo to 32/100.
    expect(trailerValue(10, 10 / 2612)).toBeLessThan(0.05);
  });

  it("still saturates when attribution is a material share of history", () => {
    expect(trailerValue(60, 0.6)).toBeGreaterThanOrEqual(0.6);
    expect(trailerValue(1, 1)).toBe(1);
  });

  it("reports exactly zero when nothing is attributed", () => {
    expect(trailerValue(0, 0)).toBe(0);
  });

  it("is continuous at the material threshold", () => {
    // No cliff: just under and just over 10% should be close together.
    expect(Math.abs(trailerValue(10, 0.099) - trailerValue(10, 0.101))).toBeLessThan(
      0.05,
    );
  });
});

describe("ground-truth confidence", () => {
  const GROUND_TRUTH = ["agent-trailers"];

  it("does not claim certainty from a weak ground-truth signal", () => {
    // Direct evidence that agents *touched* the repo is not evidence that the
    // repo is agent-written. Claiming `certain` off 0.4% of commits overstates it.
    const score = scoreDimension(
      "authorship",
      [
        signal({ id: "agent-trailers", value: 0.02, weight: 3 }),
        signal({ id: "duplicate-logic", value: 0.1, weight: 2 }),
      ],
      { groundTruthSignals: GROUND_TRUTH },
    );

    expect(score.confidence).not.toBe("certain");
  });

  it("never claims certainty at the dimension level, however strong the evidence", () => {
    /*
     * Confidence is coverage, not conviction. A ground-truth signal at full
     * strength still leaves the question "how much evidence did we gather?"
     * unanswered, and `colinhacks/zod` showed what conflating the two produces:
     * "27/100, certain confidence" narrated as "this mostly looks like
     * hand-written code" directly above "Cursor: .cursorrules present".
     *
     * `certain` still exists — on findings, where "this file is present" is
     * genuinely certain.
     */
    const score = scoreDimension(
      "authorship",
      [
        signal({ id: "agent-trailers", value: 1, weight: 3 }),
        signal({ id: "duplicate-logic", value: 1, weight: 2 }),
      ],
      { groundTruthSignals: GROUND_TRUTH },
    );

    expect(score.score).toBe(100);
    expect(score.confidence).toBe("high");
  });

  it("tracks coverage, not the strength of what it found", () => {
    const wellCovered = scoreDimension("authorship", [
      signal({ id: "a", value: 0, weight: 3 }),
      signal({ id: "b", value: 0, weight: 2 }),
    ]);
    const poorlyCovered = scoreDimension("authorship", [
      signal({ id: "a", value: 1, weight: 3 }),
      signal({
        id: "b",
        value: 0,
        weight: 7,
        available: false,
        unavailableReason: "no git history",
      }),
    ]);

    // Nothing found but everything measured beats everything found but little
    // measured — because confidence is about the evidence, not the verdict.
    expect(wellCovered.confidence).toBe("high");
    expect(poorlyCovered.confidence).toBe("low");
  });

  it("redistributes weight rather than scoring an unavailable signal as zero", () => {
    const withSignal = scoreDimension("authorship", [
      signal({ id: "a", value: 0.8, weight: 2 }),
      signal({ id: "b", value: 0.8, weight: 2 }),
    ]);
    const withoutSignal = scoreDimension("authorship", [
      signal({ id: "a", value: 0.8, weight: 2 }),
      signal({
        id: "b",
        value: 0,
        weight: 2,
        available: false,
        unavailableReason: "no git history",
      }),
    ]);

    // The score must not drop just because a signal could not be measured —
    // that would make an unanalysable repo look cleaner than an analysed one.
    expect(withoutSignal.score).toBe(withSignal.score);
    expect(withoutSignal.confidence).not.toBe(withSignal.confidence);
    expect(withoutSignal.unavailable).toEqual(["no git history"]);
  });
});

describe("a repository too large to read in full", () => {
  const full = [
    signal({ id: "a", value: 0.5, weight: 2 }),
    signal({ id: "b", value: 0.5, weight: 2 }),
  ];

  it("lowers confidence without touching the score", () => {
    const complete = scoreDimension("authorship", full);
    const partial = scoreDimension("authorship", full, { truncated: true });

    /*
     * The same invariant that governs a missing signal, applied to the largest
     * missing input there is. `FileIndex.truncated` used to produce a warning
     * string and nothing else, so a repository where a fifth of the files were
     * read reported `high` confidence exactly like one read completely — every
     * signal "available", because each one did run, over a fraction of the
     * code.
     */
    expect(partial.score).toBe(complete.score);
    expect(complete.confidence).toBe("high");
    expect(partial.confidence).toBe("low");
  });

  it("says so rather than only lowering a number", () => {
    const partial = scoreDimension("authorship", full, { truncated: true });
    expect(partial.unavailable.join(" ")).toMatch(/too large to read in full/);
  });

  it("caps confidence even when every signal ran", () => {
    // Full signal coverage is what makes this case dangerous: nothing else in
    // the result hints that the analysis was partial.
    const partial = scoreDimension("authorship", full, { truncated: true });
    expect(partial.signals.every((s) => s.available)).toBe(true);
    expect(partial.confidence).toBe("low");
  });
});

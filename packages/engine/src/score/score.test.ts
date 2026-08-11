import type { Signal } from "@vibe/shared";
import { describe, expect, it } from "vitest";

import { trailerValue } from "../analyzers/provenance/trailers";
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
      "provenance",
      [
        signal({ id: "agent-trailers", value: 0.02, weight: 3 }),
        signal({ id: "duplicate-logic", value: 0.1, weight: 2 }),
      ],
      { groundTruthSignals: GROUND_TRUTH },
    );

    expect(score.confidence).not.toBe("certain");
  });

  it("claims certainty when the ground-truth signal is strong", () => {
    const score = scoreDimension(
      "provenance",
      [
        signal({ id: "agent-trailers", value: 0.9, weight: 3 }),
        signal({ id: "duplicate-logic", value: 0.1, weight: 2 }),
      ],
      { groundTruthSignals: GROUND_TRUTH },
    );

    expect(score.confidence).toBe("certain");
  });

  it("redistributes weight rather than scoring an unavailable signal as zero", () => {
    const withSignal = scoreDimension("provenance", [
      signal({ id: "a", value: 0.8, weight: 2 }),
      signal({ id: "b", value: 0.8, weight: 2 }),
    ]);
    const withoutSignal = scoreDimension("provenance", [
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

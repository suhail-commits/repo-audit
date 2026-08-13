import { CORPUS_BASELINE, PERSONAS } from "@vibe/shared";
import { describe, expect, it } from "vitest";

import { corpusComparison } from "./corpus";

/**
 * The comparison is the one line in the report that describes a population
 * rather than the repository in front of us, so what it may claim is narrow.
 */
describe("corpus comparison", () => {
  const authorship = CORPUS_BASELINE.dimensions.authorship;

  it("always says the corpus is hand-written, never 'repositories' in general", () => {
    /*
     * The corpus is twenty projects picked for being unambiguously
     * hand-written. It can say what hand-written code scores; it cannot support
     * a percentile against software in general, because that population was
     * never sampled. CLAUDE.md records this as the reason `doc-style` was
     * abandoned — the same limitation, applied to the same corpus.
     */
    for (const persona of PERSONAS) {
      const line = corpusComparison("authorship", 5, persona);
      expect(line.toLowerCase()).toContain("hand-written");
      expect(line.toLowerCase()).not.toMatch(/percentile/);
    }
  });

  it("never turns the standing into a verdict", () => {
    // Scoring above all twenty is a fact about twenty repositories. The
    // judgement belongs to the headline.
    const worst = corpusComparison("authorship", 100, "founder");
    expect(worst.toLowerCase()).not.toMatch(
      /\b(bad|poor|worrying|concerning|fail)\b/,
    );
  });

  it("places a score inside, above and beyond the corpus differently", () => {
    const inside = corpusComparison("authorship", authorship.median, "founder");
    const above = corpusComparison("authorship", authorship.p90 + 1, "founder");
    const beyond = corpusComparison("authorship", authorship.max + 1, "founder");

    expect(new Set([inside, above, beyond]).size).toBe(3);
    expect(beyond).toMatch(new RegExp(`${CORPUS_BASELINE.repos}`));
  });

  it("treats the corpus maximum as still inside it", () => {
    // `beyond` means *exceeds every repo measured*. The repo that set the
    // maximum has not exceeded itself.
    expect(corpusComparison("authorship", authorship.max, "founder")).toBe(
      corpusComparison("authorship", authorship.p90 + 1, "founder"),
    );
  });

  it("gives the engineer the raw distribution and its date", () => {
    const line = corpusComparison("authorship", 5, "engineer");
    expect(line).toContain(String(authorship.median));
    expect(line).toContain(String(authorship.p90));
    // Undated, the reader cannot tell whether the benchmark predates the
    // signals it is being compared against.
    expect(line).toContain(CORPUS_BASELINE.measured);
  });

  it("covers every dimension, including the all-zero security corpus", () => {
    for (const dimension of ["authorship", "security", "health"] as const) {
      for (const persona of PERSONAS) {
        expect(corpusComparison(dimension, 0, persona).length).toBeGreaterThan(
          0,
        );
      }
    }
  });

  it("does not dress a flat corpus up as a distribution", () => {
    /*
     * Security scores 0 across all twenty, so median, p90 and max are equal.
     * Run through the ordinary branches, any finding at all printed "higher
     * than any of the 20 we compared against" — which sounds like a remarkable
     * standing and is really "you have at least one finding" with false
     * precision attached.
     */
    expect(CORPUS_BASELINE.dimensions.security.max).toBe(0);

    const flagged = corpusComparison("security", 26, "founder");
    expect(flagged).not.toMatch(/higher than any/i);
    expect(flagged).not.toMatch(/9 in 10/);
    expect(flagged.toLowerCase()).toContain("none of the");

    // And a clean repo is not told it beat anyone either.
    expect(corpusComparison("security", 0, "founder")).not.toMatch(/this one/i);
  });
});

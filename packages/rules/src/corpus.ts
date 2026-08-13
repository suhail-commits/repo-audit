import {
  CORPUS_BASELINE,
  corpusStanding,
  type Dimension,
  type Persona,
} from "@vibe/shared";

/**
 * "Is 21 a lot?" — answered from the sweep, in the reader's register.
 *
 * The whole value of this line is that it comes from measurement rather than
 * from our own band thresholds, so the phrasing has to keep saying *what* was
 * measured. Two rules hold in every branch:
 *
 * 1. **Always "hand-written repositories", never "repositories".** The corpus
 *    is twenty projects chosen for being unambiguously hand-written. It can say
 *    what hand-written code scores. It cannot support a percentile against
 *    software in general, which is a population we never sampled.
 * 2. **Never a verdict.** Scoring above all twenty is a fact about twenty
 *    repositories, not evidence of anything. The headline is where judgement
 *    lives; this only places the number.
 */
export function corpusComparison(
  dimension: Dimension,
  score: number,
  persona: Persona,
): string {
  const band = CORPUS_BASELINE.dimensions[dimension];
  const { repos } = CORPUS_BASELINE;

  if (persona === "engineer") {
    return (
      `Corpus: median ${band.median}, p90 ${band.p90}, max ${band.max} ` +
      `over ${repos} hand-written repos (${CORPUS_BASELINE.measured}).`
    );
  }

  /*
   * A corpus with no spread cannot be described as a distribution.
   *
   * Security scores zero on all twenty — a live credential in one of the
   * most-read repositories in open source would have been revoked years ago —
   * so median, p90 and max are all 0. Run through the branches below, any
   * finding at all prints "higher than any of the 20 we compared against",
   * which sounds like a remarkable standing and is really just "you have at
   * least one finding", said with false precision. Say what the corpus shows
   * instead.
   */
  if (band.max === 0) {
    const none = `None of the ${repos} hand-written repositories we compare against had anything flagged here.`;
    return score > 0 ? `${none} This one does.` : none;
  }

  const standing = corpusStanding(dimension, score);

  if (persona === "acquirer") {
    const benchmark = `Benchmark: ${repos} hand-written repositories score a median of ${band.median}, with 9 in 10 at or below ${band.p90}.`;
    switch (standing) {
      case "beyond":
        return `${benchmark} This sits above all of them.`;
      case "above":
        return `${benchmark} This sits in the upper tenth.`;
      case "at-or-below":
        return `${benchmark} This is within the ordinary range.`;
    }
  }

  /*
   * Owner. "Most" rather than a percentile — a median stated as "most projects
   * score around 6" is true and readable, where "you are in the 90th
   * percentile" would be arithmetic over twenty samples dressed up as a
   * population statistic.
   */
  const most = `Most hand-written projects we've measured score around ${band.median}, and 9 in 10 come in at or below ${band.p90}.`;
  switch (standing) {
    case "beyond":
      return `${most} This one is higher than any of the ${repos} we compared against.`;
    case "above":
      return `${most} This one is higher than most of them.`;
    case "at-or-below":
      return `${most} This one is in that range.`;
  }
}

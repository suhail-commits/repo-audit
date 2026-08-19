import type {
  Dimension,
  DimensionScore,
  Finding,
  Location,
  Persona,
  ScanResult,
  Severity,
} from "@vibe/shared";

/** A finding rendered as prose for one persona. */
export interface NarratedFinding {
  ruleId: string;
  /**
   * Carried through so the report can file the finding under the right section.
   * The report is organised by dimension, and matching narrated findings back
   * to the raw ones by index would break the moment sorting changed.
   */
  dimension: Dimension;
  severity: Severity;
  /** One line naming the problem. */
  title: string;
  /** A sentence or two explaining it in this persona's register. */
  body: string;
  /**
   * Persona-specific follow-up: the consequence for a founder, the fix for an
   * engineer, the remediation cost for an acquirer.
   */
  detail: string[];
  locations: Location[];
}

export interface NarratedScore {
  dimension: string;
  score: number;
  /** The verdict sentence — the one line that carries the whole section. */
  headline: string;
  /** Why we believe it, drawn from the signals that actually fired. */
  evidence: string[];
  /** What we could not measure, and therefore what the score does not cover. */
  caveats: string[];
}

export interface NarratedReport {
  persona: Persona;
  /** The single sentence the report opens with. */
  headline: string;
  summary: string;
  /**
   * What the reader should take from this — whether anything needs attention.
   *
   * Composed from measured values only (the band, the finding count, coverage).
   * This is the one place the report edges from measurement toward advice, so
   * every clause has to trace back to something counted.
   */
  verdict: string;
  /**
   * What to open first, across every section.
   *
   * The report shows one dimension at a time, so its finding list is filtered to
   * that section — which leaves a reader with no answer to "of everything you
   * found, what matters most?". A committed credential and a duplicated helper
   * sit in different tabs and read as equally urgent.
   *
   * Ranked, capped, and **drawn entirely from findings the analyzers already
   * emitted**. This orders and filters; it never originates (invariant 6). Info
   * findings are excluded — they are context, not tasks.
   */
  priorities: NarratedFinding[];
  scores: NarratedScore[];
  findings: NarratedFinding[];
}

/**
 * Turns structured findings into prose.
 *
 * The engine emits data; this decides how it reads. Keeping it behind an
 * interface means a different implementation — a local model, a paid API — can
 * be swapped in later without touching a single analyzer.
 */
export interface Narrator {
  finding(finding: Finding, persona: Persona): NarratedFinding;
  /**
   * `findings` is optional and only the security headline reads it.
   *
   * That dimension's signals are presence-shaped, so its score alone cannot
   * carry the verdict: a single committed credential can sit at 8/100 while
   * being the most serious thing in the report. The headline comes from the
   * worst finding instead, and needs them to do it.
   */
  score(
    score: DimensionScore,
    persona: Persona,
    findings?: Finding[],
  ): NarratedScore;
  report(result: ScanResult, persona: Persona): NarratedReport;
}

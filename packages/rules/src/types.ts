import type {
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
  score(score: DimensionScore, persona: Persona): NarratedScore;
  report(result: ScanResult, persona: Persona): NarratedReport;
}

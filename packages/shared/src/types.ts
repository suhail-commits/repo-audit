/**
 * The contract between the engine, the rules/templates package, and the web app.
 * The engine produces a ScanResult; the rules package turns it into prose; the
 * web app renders it. Nothing else crosses those boundaries.
 */

/** Who is reading the report. Chosen during onboarding, stored on the scan. */
export type Persona = "founder" | "engineer" | "acquirer";

export const PERSONAS: readonly Persona[] = ["founder", "engineer", "acquirer"];

/** The four questions the product answers. */
export type Dimension = "authorship" | "security" | "quality" | "architecture";

export const DIMENSIONS: readonly Dimension[] = [
  "authorship",
  "security",
  "quality",
  "architecture",
];

export type Severity = "critical" | "high" | "medium" | "low" | "info";

/** Ascending order — higher index is worse. Used for sorting report sections. */
export const SEVERITY_ORDER: readonly Severity[] = [
  "info",
  "low",
  "medium",
  "high",
  "critical",
];

export function severityRank(s: Severity): number {
  return SEVERITY_ORDER.indexOf(s);
}

/**
 * How much we trust a finding or a score.
 *
 * `certain` is reserved for ground truth — e.g. a literal `Co-Authored-By: Claude`
 * trailer in git history. Heuristics never claim `certain`.
 */
export type Confidence = "certain" | "high" | "medium" | "low";

export const CONFIDENCE_ORDER: readonly Confidence[] = [
  "low",
  "medium",
  "high",
  "certain",
];

export function confidenceRank(c: Confidence): number {
  return CONFIDENCE_ORDER.indexOf(c);
}

/** Lowest confidence wins — a chain is only as trustworthy as its weakest link. */
export function minConfidence(...cs: Confidence[]): Confidence {
  if (cs.length === 0) return "low";
  return cs.reduce((a, b) => (confidenceRank(b) < confidenceRank(a) ? b : a));
}

/** A position in the analyzed repo. Paths are always repo-relative, POSIX-separated. */
export interface Location {
  file: string;
  /** 1-indexed. Omitted for file-level or repo-level findings. */
  line?: number;
  endLine?: number;
  /** Optional source excerpt for the engineer persona. */
  excerpt?: string;
}

/** Which analyzer or vendored tool produced a finding. */
export type FindingSource = "builtin" | "semgrep" | "gitleaks" | "osv";

/**
 * One thing wrong with the codebase.
 *
 * `data` holds the slot values the report template interpolates — templates never
 * reach into anything else, so a rule and its prose stay decoupled.
 */
export interface Finding {
  ruleId: string;
  dimension: Dimension;
  severity: Severity;
  confidence: Confidence;
  source: FindingSource;
  /** Short rule-level title. Persona-specific prose comes from the Narrator. */
  title: string;
  locations: Location[];
  data: Record<string, string | number | boolean | string[]>;
  /** Rough remediation effort, used by the acquirer persona. */
  estimatedFixMinutes?: number;
}

export type MetricUnit = "count" | "percent" | "ratio" | "loc" | "days";

/** A measurement. Metrics describe the repo; findings assert something is wrong. */
export interface Metric {
  id: string;
  dimension: Dimension;
  label: string;
  value: number;
  unit: MetricUnit;
}

/**
 * One input to a dimension score.
 *
 * `available: false` means the inputs this signal needs were missing (most often
 * git history on a zip upload with no .git). An unavailable signal is excluded
 * from the weighted average and its weight is redistributed — it must never be
 * silently treated as a zero, which would read as "clean".
 */
export interface Signal {
  id: string;
  /** Normalized 0..1, where 1 is maximally indicative of the thing being detected. */
  value: number;
  weight: number;
  available: boolean;
  /** Why this signal fired, in human-readable fragments. Shown as evidence. */
  evidence: string[];
  /** Set when available is false, explaining what was missing. */
  unavailableReason?: string;
}

export interface DimensionScore {
  dimension: Dimension;
  /** 0..100. For authorship, higher means more likely AI-generated. */
  score: number;
  confidence: Confidence;
  signals: Signal[];
  /** Human-readable list of what could not be measured. */
  unavailable: string[];
}

/** The architecture verdict, with the evidence that produced it. */
export type ArchitectureVerdict =
  | "stay-monolith"
  | "split-candidate"
  | "distributed-monolith"
  | "already-appropriate"
  | "insufficient-evidence";

export interface ArchitectureAssessment {
  verdict: ArchitectureVerdict;
  /** Newman modularity Q of the import graph, 0..1. */
  modularity: number;
  moduleCount: number;
  serviceCount: number;
  evidence: string[];
}

/**
 * How deeply a language can be analyzed.
 *
 * Every repository gets a real verdict; the tier records how much evidence was
 * reachable. A language we cannot parse must never quietly score lower than one
 * we can — it scores on fewer signals, at lower confidence, and says so.
 */
export type AnalysisTier =
  /** Parsed semantically: every signal, plus framework-aware rules. */
  | "full"
  /** Parsed structurally: duplication, comment narration, test assertions. */
  | "structural"
  /** Not parsed: commit history and repository shape only. */
  | "history";

export interface LanguageShare {
  language: string;
  label: string;
  tier: AnalysisTier;
  files: number;
  sloc: number;
  /** Share of authored source lines, 0-1. */
  share: number;
}

/** How the repo got here — determines which signals are even possible. */
export type IngestKind = "github" | "zip";

export interface RepoInfo {
  kind: IngestKind;
  /** Display name: "owner/repo" for GitHub, the zip filename otherwise. */
  name: string;
  /** Absolute path to the checkout on disk. Not persisted to the DB. */
  rootPath: string;
  hasGitHistory: boolean;
  /** Every file indexed, including manifests and docs. */
  fileCount: number;
  /**
   * Authored source files only — excludes tests, generated output, lockfiles and
   * non-code. Pair this with `totalLoc`, which is measured over the same set;
   * quoting `totalLoc` against `fileCount` understates the density.
   */
  sourceFileCount: number;
  /** Non-blank lines across authored source. */
  totalLoc: number;
  /** Detected frameworks, e.g. ["next", "supabase"]. Drives which rules run. */
  frameworks: string[];
  /** Languages present, descending by lines of code. */
  languages: LanguageShare[];
  /** The tier the bulk of this repository could be analyzed at. */
  analysisTier: AnalysisTier;
}

export interface ScanResult {
  schemaVersion: 1;
  repo: RepoInfo;
  scores: DimensionScore[];
  findings: Finding[];
  metrics: Metric[];
  architecture: ArchitectureAssessment;
  /** Wall-clock analysis time, for the ops view. */
  durationMs: number;
  /** Non-fatal problems during analysis — unparseable files, tool crashes. */
  warnings: string[];
}

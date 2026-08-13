/**
 * The contract between the engine, the rules/templates package, and the web app.
 * The engine produces a ScanResult; the rules package turns it into prose; the
 * web app renders it. Nothing else crosses those boundaries.
 */

/** Who is reading the report. Chosen during onboarding, stored on the scan. */
export type Persona = "founder" | "engineer" | "acquirer";

export const PERSONAS: readonly Persona[] = ["founder", "engineer", "acquirer"];

/**
 * The three questions the product answers.
 *
 * `health` absorbs what were separate `quality` and `architecture` dimensions.
 * They asked the same question — is this codebase in good shape — and splitting
 * them produced two thin sections instead of one substantial one. Structure
 * findings (coupling, cycles, oversized modules) are health findings.
 */
export type Dimension = "authorship" | "security" | "health";

export const DIMENSIONS: readonly Dimension[] = [
  "authorship",
  "security",
  "health",
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
  /**
   * Which files this signal implicates, keyed by repo-relative path, 0..1.
   *
   * **Sparse — only files with a non-zero value appear.** Most files are not
   * implicated by most signals, so recording every file would multiply the
   * stored result by the file count for no information.
   *
   * **A plain object, not a `Map`.** `ScanResult` is `JSON.stringify`d into
   * Postgres, and a `Map` serialises to `{}` — which would work in development,
   * where the fallback store keeps the live object, and silently lose every
   * per-file value in production.
   *
   * Absent on signals that are repo-wide by nature: a commit trailer or a
   * committed `CLAUDE.md` says something about the repository, not about any
   * particular file, and inventing a per-file value for them would be a
   * fabricated measurement.
   */
  perFile?: Readonly<Record<string, number>>;
}

/**
 * A directory the file-attributable signals point at, for the report's
 * "where the signs are strongest" ranking.
 *
 * **Deliberately carries no 0-100 score.** Only some signals can attribute to a
 * file, so a directory number could never reconcile with the dimension score
 * above it — two numbers on one page that cannot be compared is worse than one
 * number and an ordering. `intensity` is relative within this list only.
 */
export interface DirectoryRank {
  /** Repo-relative directory path, POSIX separators, no trailing slash. */
  path: string;
  /** Source files counted under it. */
  files: number;
  /** 0..1, normalised against the strongest directory in the same list. */
  intensity: number;
  /** Signal ids that implicated this directory, strongest first. */
  signals: string[];
}

export interface DimensionScore {
  dimension: Dimension;
  /** 0..100. For authorship, higher means more likely AI-generated. */
  score: number;
  confidence: Confidence;
  signals: Signal[];
  /** Human-readable list of what could not be measured. */
  unavailable: string[];
  /**
   * Where the file-attributable signals concentrate, strongest first.
   *
   * Empty when no available signal carries per-file data — the honest answer
   * for a repository whose evidence is all history-shaped — and must render as
   * "no ranking" rather than as an empty chart.
   *
   * **Optional because scans stored before this existed do not have it.**
   * `ScanResult` is persisted as jsonb and read back by the report, so a
   * required field here would be a claim about rows that predate it.
   */
  hotspots?: DirectoryRank[];
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

  /**
   * The exact revision analysed, when the history source names one.
   *
   * A report with no revision on it is a claim about "the repository", which is
   * a moving target. The same repo scanned from a local checkout and through
   * the GitHub API legitimately produced 11,436 and 7,519 lines on the same
   * afternoon — one had unpushed work — and nothing on the page explained why.
   *
   * Optional because a zip upload has no commits to take it from, and because
   * scans stored before this existed do not carry it.
   */
  headSha?: string;
}

export interface ScanResult {
  schemaVersion: 1;
  repo: RepoInfo;
  scores: DimensionScore[];
  findings: Finding[];
  metrics: Metric[];
  /**
   * Which dimensions an analyzer actually ran for.
   *
   * Not derivable from `scores` or `findings`: a dimension that ran and found
   * nothing produces exactly the same empty output as one with no analyzer at
   * all, and the report must not present the second as the first. Stated by
   * the engine so it cannot drift out of sync with what is registered.
   */
  analysedDimensions: Dimension[];

  /**
   * How the codebase is put together, aggregated to directories.
   *
   * Absent — never an empty graph — when there is nothing honest to draw:
   * `ImportGraph` resolves JS/TS only, so a Python repository has no edges at
   * all and would render as boxes with no lines between them, a confident
   * picture of a codebase where nothing imports anything.
   *
   * Optional for the same reason `DimensionScore.hotspots` is: `ScanResult` is
   * persisted as jsonb and read back, so a required field would be a claim
   * about rows that predate it.
   */
  moduleGraph?: ModuleGraph;

  /** Wall-clock analysis time, for the ops view. */
  durationMs: number;
  /** Non-fatal problems during analysis — unparseable files, tool crashes. */
  warnings: string[];
}

/** One directory in the module map, and how much code it holds. */
export interface ModuleGraphNode {
  path: string;
  files: number;
}

/** `count` is how many individual imports the directory-level edge stands for. */
export interface ModuleGraphEdge {
  from: string;
  to: string;
  count: number;
}

export interface ModuleGraph {
  nodes: ModuleGraphNode[];
  edges: ModuleGraphEdge[];
  /** Directories left off the diagram by the node cap. Stated, never silent. */
  omitted: number;
}

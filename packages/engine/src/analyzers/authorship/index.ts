import type { DimensionScore, Finding, Signal } from "@vibe/shared";

import { scoreDimension } from "../../score/index";
import type { AnalysisContext } from "../context";
import {
  buildVelocitySignal,
  commitMessageSignal,
  commitSizeSignal,
  writeOnceFilesSignal,
} from "./commit-shape";
import { refactorRatioSignal } from "./rework";
import {
  analyzeClones,
  cloneFindings,
  cloneSignal,
  type CloneReport,
} from "./clones";
import { obviousCommentSignal, tautologicalTestSignal } from "./comments";
import {
  deadCodeFindings,
  orphanFileSignal,
  overlappingUtilsSignal,
  unusedDependencySignal,
} from "./dead";
import { conventionDriftSignal } from "./drift";
import { swallowedErrorFindings, swallowedErrorSignal } from "./errors";
import {
  agentToolingSignal,
  platformFindings,
  platformSignal,
} from "./platform";
import { agentTrailerSignal, attributedAgents } from "./trailers";

export interface AuthorshipResult {
  score: DimensionScore;
  findings: Finding[];
  /** Agents named in commit history, if any. */
  agents: string[];
  clones: CloneReport;
}

/**
 * Signals that constitute direct evidence rather than inference. When one fires,
 * the score is reported at `certain` confidence.
 */
const GROUND_TRUTH = ["agent-trailers", "builder-platform", "agent-tooling"];

/**
 * Signals excluded when calibrating against the labeled corpus.
 *
 * If the corpus can be separated using commit trailers and platform artifacts
 * alone, nothing has been learned about whether the structural signals work — so
 * calibration runs must disable them and separate the groups on structure only.
 */
export const GROUND_TRUTH_SIGNAL_IDS = GROUND_TRUTH;

export interface AuthorshipOptions {
  /** Drop ground-truth signals. Used by calibration tests. */
  structuralOnly?: boolean;
}

export function analyzeAuthorship(
  ctx: AnalysisContext,
  options: AuthorshipOptions = {},
): AuthorshipResult {
  const clones = analyzeClones(ctx);

  const signals: Signal[] = [
    // Direct evidence.
    agentTrailerSignal(ctx),
    platformSignal(ctx),
    agentToolingSignal(ctx),
    // History shape.
    commitSizeSignal(ctx),
    commitMessageSignal(ctx),
    buildVelocitySignal(ctx),
    writeOnceFilesSignal(ctx),
    refactorRatioSignal(ctx),
    // Structure — these are the signals that survive a zip with no git history.
    cloneSignal(ctx, clones),
    conventionDriftSignal(ctx),
    unusedDependencySignal(ctx),
    orphanFileSignal(ctx),
    overlappingUtilsSignal(ctx),
    obviousCommentSignal(ctx),
    tautologicalTestSignal(ctx),
    swallowedErrorSignal(ctx),
  ];

  const used = options.structuralOnly
    ? signals.filter((s) => !GROUND_TRUTH.includes(s.id))
    : signals;

  const score = scoreDimension("authorship", used, {
    groundTruthSignals: options.structuralOnly ? [] : GROUND_TRUTH,
    // Source files only: the denominators for the directory ranking have to
    // match the set the signals judge, or a directory full of tests reads as
    // clean simply because nothing looked at it.
    sourceFiles: ctx.files.sourceFiles().map((f) => f.relPath),
    truncated: ctx.files.truncated,
  });

  const findings: Finding[] = [
    ...(options.structuralOnly ? [] : platformFindings(ctx)),
    ...cloneFindings(clones),
    ...deadCodeFindings(ctx),
    ...swallowedErrorFindings(ctx),
  ];

  const agents = options.structuralOnly ? [] : attributedAgents(ctx);
  if (agents.length > 0) {
    findings.unshift({
      ruleId: "ai-authored-commits",
      dimension: "authorship",
      severity: "info",
      confidence: "certain",
      source: "builtin",
      title: `Commit history is explicitly attributed to ${agents.join(", ")}`,
      locations: [],
      data: { agents },
    });
  }

  return { score, findings, agents, clones };
}

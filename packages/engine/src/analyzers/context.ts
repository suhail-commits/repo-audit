import type { Signal } from "@vibe/shared";

import type { AstIndex } from "../index/ast";
import type { FileIndex } from "../index/files";
import type { FrameworkInfo } from "../index/frameworks";
import type { GitIndex } from "../index/git";
import type { ImportGraph } from "../index/imports";
import type { LanguageProfile } from "../index/language";
import type { PythonIndex } from "../index/python";
import type { RouteTable } from "../index/routes";

/**
 * Everything an analyzer is allowed to read. Analyzers never touch the
 * filesystem or re-parse — they only read these shared indexes.
 */
export interface AnalysisContext {
  files: FileIndex;
  /** JS/TS semantic trees. Empty for a repository with no JS/TS. */
  asts: AstIndex;
  /** Python structural trees. Empty for a repository with no Python. */
  python: PythonIndex;
  git: GitIndex;
  graph: ImportGraph;
  routes: RouteTable;
  frameworks: FrameworkInfo;
  /** Which languages are present, and how deeply each could be analyzed. */
  languages: LanguageProfile;
}

/** A named signal producer, so the scorer can report which ones were skipped. */
export interface SignalDefinition {
  id: string;
  label: string;
  weight: number;
  compute(ctx: AnalysisContext): Signal;
}

/** Helper for a signal whose inputs were missing. */
export function unavailable(
  id: string,
  weight: number,
  reason: string,
): Signal {
  return {
    id,
    value: 0,
    weight,
    available: false,
    evidence: [],
    unavailableReason: reason,
  };
}

/** Clamp a raw ratio into the 0..1 range signals are defined over. */
export function clamp01(value: number): number {
  if (!Number.isFinite(value)) return 0;
  return Math.min(1, Math.max(0, value));
}

/**
 * Map a measurement onto 0..1 with a soft floor and ceiling.
 * Below `low` the signal reads 0; above `high` it saturates at 1.
 */
export function ramp(value: number, low: number, high: number): number {
  if (high <= low) return value >= high ? 1 : 0;
  return clamp01((value - low) / (high - low));
}

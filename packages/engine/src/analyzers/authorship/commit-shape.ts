import type { Signal } from "@vibe/shared";

import { clamp01, ramp, unavailable, type AnalysisContext } from "../context";

/**
 * Distributional properties of the commit history.
 *
 * Hand-written repos accumulate in small, frequent, differently-sized commits over
 * many days. Agent-built repos land in a handful of very large commits over very
 * few days, with low-information messages, and most files are never touched again
 * after the commit that created them.
 *
 * None of these is conclusive alone — a solo developer on a weekend project can
 * look similar — which is why they are weighted signals rather than verdicts.
 */

export const WEIGHTS = {
  commitSize: 2,
  commitMessages: 1.5,
  buildVelocity: 2,
  writeOnceFiles: 1.5,
} as const;

/** Below this, distributional statistics are meaningless. */
const MIN_COMMITS = 5;

export function commitSizeSignal(ctx: AnalysisContext): Signal {
  const id = "commit-size";
  const reason = historyGap(ctx);
  if (reason) return unavailable(id, WEIGHTS.commitSize, reason);

  const churns = ctx.git.commits.map((c) => c.churn).filter((n) => n > 0);
  if (churns.length < MIN_COMMITS) {
    // Distinguish "this history has no sizeable commits" from "the source we
    // read history from does not report line counts" — the second is a gap in
    // our data, not a property of the repository.
    return unavailable(
      id,
      WEIGHTS.commitSize,
      churns.length === 0
        ? "commit line counts are unavailable from this history source"
        : "too few commits with changes",
    );
  }

  const median = percentile(churns, 0.5);
  const p90 = percentile(churns, 0.9);

  return {
    id,
    // A median commit of 80 lines is unremarkable; 600 is not something a person
    // typically produces by hand in one sitting.
    value: ramp(median, 80, 600),
    weight: WEIGHTS.commitSize,
    available: true,
    evidence: [
      `Median commit changes ${median} lines (typical hand-written: 10-60)`,
      `Largest 10% of commits change ${p90}+ lines`,
    ],
  };
}

const GENERIC_SUBJECT =
  /^(fix(es|ed)?|wip|update[sd]?|change[sd]?|misc|stuff|test|tweak|cleanup|refactor|done|final|initial commit|commit|asdf|\.+)$/i;

export function commitMessageSignal(ctx: AnalysisContext): Signal {
  const id = "commit-messages";
  const reason = historyGap(ctx);
  if (reason) return unavailable(id, WEIGHTS.commitMessages, reason);

  const subjects = ctx.git.commits.map((c) => c.subject.trim());
  if (subjects.length < MIN_COMMITS) {
    return unavailable(id, WEIGHTS.commitMessages, "too few commits");
  }

  const generic = subjects.filter(
    (s) => GENERIC_SUBJECT.test(s) || s.length < 8,
  ).length;

  const counts = new Map<string, number>();
  for (const s of subjects) {
    const key = s.toLowerCase();
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }
  const duplicated = [...counts.values()]
    .filter((n) => n > 1)
    .reduce((sum, n) => sum + n, 0);

  const genericRatio = generic / subjects.length;
  const duplicateRatio = duplicated / subjects.length;
  const combined = clamp01(Math.max(genericRatio, duplicateRatio * 0.8));

  const evidence: string[] = [];
  if (generic > 0) {
    evidence.push(
      `${generic} of ${subjects.length} commit messages carry no information ("fix", "wip", "update")`,
    );
  }
  if (duplicated > 0) {
    const worst = [...counts.entries()].sort((a, b) => b[1] - a[1])[0]!;
    evidence.push(`"${worst[0]}" is used as a commit message ${worst[1]} times`);
  }

  return {
    id,
    value: ramp(combined, 0.15, 0.6),
    weight: WEIGHTS.commitMessages,
    available: true,
    evidence,
  };
}

export function buildVelocitySignal(ctx: AnalysisContext): Signal {
  const id = "build-velocity";
  const reason = historyGap(ctx);
  if (reason) return unavailable(id, WEIGHTS.buildVelocity, reason);

  const activeDays = Math.max(1, ctx.git.activeDays());
  const sloc = ctx.files.totalSloc;
  if (sloc < 200) {
    return unavailable(id, WEIGHTS.buildVelocity, "codebase too small to judge");
  }

  const slocPerDay = sloc / activeDays;
  const authors = ctx.git.authors().length;

  // A team legitimately produces more per day; normalize so a 5-person team is
  // not flagged for the output of 5 people.
  const perAuthorPerDay = slocPerDay / Math.max(1, authors);

  return {
    id,
    value: ramp(perAuthorPerDay, 400, 3000),
    weight: WEIGHTS.buildVelocity,
    available: true,
    evidence: [
      `${sloc.toLocaleString()} lines of source across ${activeDays} day(s) of commits`,
      `Roughly ${Math.round(perAuthorPerDay).toLocaleString()} lines per author per active day`,
      authors === 1
        ? "Single contributor across the entire history"
        : `${authors} contributors`,
    ],
  };
}

export function writeOnceFilesSignal(ctx: AnalysisContext): Signal {
  const id = "write-once-files";
  const reason = historyGap(ctx);
  if (reason) return unavailable(id, WEIGHTS.writeOnceFiles, reason);

  // This signal counts files touched exactly once, so it needs every commit's
  // file list. Computed over a sample it would report files as write-once purely
  // because the commit that changed them again was not fetched.
  if (!ctx.git.statsComplete) {
    return unavailable(
      id,
      WEIGHTS.writeOnceFiles,
      "per-file change data is incomplete for this history",
    );
  }

  const touched = new Set<string>();
  for (const c of ctx.git.commits) for (const f of c.files) touched.add(f.relPath);
  if (touched.size < 15) {
    return unavailable(id, WEIGHTS.writeOnceFiles, "too few files in history");
  }

  const writeOnce = ctx.git.writeOnceFiles();
  const ratio = writeOnce.length / touched.size;

  return {
    id,
    // Some write-once files are normal (configs, types). Nearly all of them
    // being write-once means the code was emitted, not iterated on.
    value: ramp(ratio, 0.55, 0.95),
    weight: WEIGHTS.writeOnceFiles,
    available: true,
    evidence: [
      `${writeOnce.length} of ${touched.size} files (${Math.round(ratio * 100)}%) were created once and never edited again`,
    ],
  };
}

function historyGap(ctx: AnalysisContext): string | null {
  if (!ctx.git.available) {
    return ctx.git.unavailableReason ?? "git history unavailable";
  }
  if (ctx.git.commitCount < MIN_COMMITS) {
    return `only ${ctx.git.commitCount} commit(s) in history`;
  }
  return null;
}

/** Nearest-rank percentile over an unsorted numeric array. */
export function percentile(values: number[], p: number): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const index = Math.min(
    sorted.length - 1,
    Math.max(0, Math.ceil(p * sorted.length) - 1),
  );
  return sorted[index]!;
}

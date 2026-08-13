import type { DirectoryRank, Signal } from "@vibe/shared";

/**
 * Where the file-attributable signals concentrate.
 *
 * A single score for a repository is an average, and averages hide the thing
 * people most want to know: real codebases are mixed. One folder is generated
 * scaffolding and the next is hand-written core, and a number in the twenties
 * describes neither.
 *
 * **This is a ranking, not a set of scores.** Only some signals can say which
 * file they mean — a commit trailer cannot — so a per-directory number could
 * never add up to the dimension score printed above it. Two numbers on one page
 * that look comparable and are not is worse than one number and an ordering.
 */

/**
 * Directories with fewer files than this are folded into their parent.
 *
 * One implicated file in a folder of one is not a concentration, it is a file.
 * Ranking it first would be the same too-small-a-sample error that made
 * `build-velocity` report a single day as a rate.
 */
const MIN_FILES = 3;

/** Beyond this the list stops being scannable and starts being a file tree. */
const MAX_RESULTS = 6;

/**
 * A ranking needs something to rank against.
 *
 * A single bar at full length says "the signs are strongest here" about the
 * only place there is, which is not information. Seen on `sindresorhus/p-limit`,
 * where every source file sits at the repo root: the section rendered one
 * entry, `.`, at 100%.
 */
const MIN_RESULTS = 2;

export interface HotspotOptions {
  /** Every source file in the repo, repo-relative. Sets the denominators. */
  sourceFiles: string[];
}

/**
 * Weighted mean of each signal's per-file value, bucketed by directory.
 *
 * Weighting matches the scorer: a signal's say here is proportional to what it
 * contributes to the score, so the ranking and the number are arguing from the
 * same evidence.
 */
export function computeHotspots(
  signals: Signal[],
  options: HotspotOptions,
): DirectoryRank[] {
  const contributing = signals.filter(
    (s) => s.available && s.perFile && Object.keys(s.perFile).length > 0,
  );
  if (contributing.length === 0) return [];

  const totalWeight = contributing.reduce((sum, s) => sum + s.weight, 0);
  if (totalWeight === 0) return [];

  // Every source file counts toward its directory's denominator, including the
  // ones no signal implicated. Without that, a directory with one bad file out
  // of fifty would rank level with one where every file is bad.
  const fileCount = new Map<string, number>();
  for (const file of options.sourceFiles) {
    const dir = directoryOf(file);
    fileCount.set(dir, (fileCount.get(dir) ?? 0) + 1);
  }
  if (fileCount.size === 0) return [];

  const { target: folded, bucketFiles } = foldSmallDirectories(fileCount);

  const scoreByDir = new Map<string, number>();
  const signalsByDir = new Map<string, Map<string, number>>();

  for (const signal of contributing) {
    for (const [file, value] of Object.entries(signal.perFile!)) {
      if (value <= 0) continue;
      const dir = folded.get(directoryOf(file));
      // A file outside the source set — a test, say — has no bucket. Skipping
      // it is right: its directory's denominator does not include it either.
      if (dir === undefined) continue;

      const contribution = (value * signal.weight) / totalWeight;
      scoreByDir.set(dir, (scoreByDir.get(dir) ?? 0) + contribution);

      const perSignal = signalsByDir.get(dir) ?? new Map<string, number>();
      perSignal.set(signal.id, (perSignal.get(signal.id) ?? 0) + contribution);
      signalsByDir.set(dir, perSignal);
    }
  }

  if (scoreByDir.size === 0) return [];

  const ranked = [...scoreByDir.entries()]
    // The repo root is where anything that cannot merge upward ends up, so it
    // is the one bucket that can survive undersized. Two files is not a
    // concentration, and ranking it would say otherwise.
    .filter(([path]) => (bucketFiles.get(path) ?? 0) >= MIN_FILES)
    .map(([path, total]) => {
      const files = bucketFiles.get(path) ?? 1;
      return {
        path,
        files,
        // Density, not volume: a large directory should not rank first purely
        // for containing more files than the others.
        density: total / files,
        signals: [...(signalsByDir.get(path) ?? new Map())]
          .sort((a, b) => b[1] - a[1])
          .map(([id]) => id),
      };
    })
    .sort((a, b) => b.density - a.density)
    .slice(0, MAX_RESULTS);

  if (ranked.length < MIN_RESULTS) return [];

  const strongest = ranked[0]?.density ?? 0;
  if (strongest <= 0) return [];

  return ranked.map(
    (entry): DirectoryRank => ({
      path: entry.path,
      files: entry.files,
      intensity: entry.density / strongest,
      signals: entry.signals,
    }),
  );
}

/** `src/a/b/c.ts` → `src/a/b`; a root-level file → `.`. */
export function directoryOf(relPath: string): string {
  const cut = relPath.lastIndexOf("/");
  return cut === -1 ? "." : relPath.slice(0, cut);
}

/**
 * Merge directories upward until every surviving bucket holds `MIN_FILES`.
 *
 * Deepest-first, so a small directory pushes its files into its parent and the
 * parent is then judged on the combined total. Every bucket that survives has
 * enough files for its density to mean something.
 *
 * **The first version compared against a directory's *cumulative* count —
 * itself plus everything beneath it — and that was wrong.** Subdirectories fold
 * to their own buckets, so the cumulative figure counts files the bucket never
 * receives: `apps/web` qualified on the hundreds of files under `apps/web/src`,
 * then ranked on a denominator of the one file it actually holds. A single
 * implicated file over a denominator of one is the strongest possible density,
 * which is how a directory with one config file in it came second.
 *
 * Returns both the redirect map and the file count each surviving bucket ends
 * up with, since the second is the denominator and recomputing it invites the
 * two to disagree.
 */
function foldSmallDirectories(fileCount: ReadonlyMap<string, number>): {
  target: Map<string, string>;
  bucketFiles: Map<string, number>;
} {
  const held = new Map<string, number>(fileCount);

  /*
   * Seed every ancestor at zero, including ones holding no files of their own.
   *
   * Without this the work list contains only directories with direct files, so
   * an intermediate directory that *receives* a merged child never gets its own
   * turn to merge onward: `apps/web/src/app/api` holds nothing directly, took
   * one file from `api/scans`, and survived as a one-file bucket ranked first.
   */
  for (const dir of [...held.keys()]) {
    let current = dir;
    while (current !== ".") {
      current = parentOf(current);
      if (!held.has(current)) held.set(current, 0);
    }
  }

  const redirect = new Map<string, string>();
  const deepestFirst = [...held.keys()].sort(
    (a, b) => depthOf(b) - depthOf(a) || a.localeCompare(b),
  );

  for (const dir of deepestFirst) {
    if (dir === ".") continue;
    const count = held.get(dir) ?? 0;
    if (count >= MIN_FILES) continue;

    const parent = parentOf(dir);
    held.set(parent, (held.get(parent) ?? 0) + count);
    held.delete(dir);
    redirect.set(dir, parent);
  }

  // A parent can itself be merged after receiving children, so resolve chains.
  const resolve = (dir: string): string => {
    let current = dir;
    const seen = new Set<string>();
    while (redirect.has(current) && !seen.has(current)) {
      seen.add(current);
      current = redirect.get(current)!;
    }
    return current;
  };

  const target = new Map<string, string>();
  for (const dir of fileCount.keys()) target.set(dir, resolve(dir));

  return { target, bucketFiles: held };
}

function depthOf(dir: string): number {
  return dir === "." ? 0 : dir.split("/").length;
}

/** `a/b/c` → `a/b`; `a` → `.`. */
function parentOf(dir: string): string {
  const cut = dir.lastIndexOf("/");
  return cut === -1 ? "." : dir.slice(0, cut);
}

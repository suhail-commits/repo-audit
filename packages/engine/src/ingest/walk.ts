import { readdir, stat } from "node:fs/promises";
import path from "node:path";

import {
  IGNORED_DIRS,
  LIMITS,
  isRelevantFile,
  normalizePath,
} from "./guards";

export interface WalkedFile {
  /** Repo-relative, POSIX separators. The key used by every index. */
  relPath: string;
  absPath: string;
  sizeBytes: number;
}

export interface WalkResult {
  files: WalkedFile[];
  /** True if a limit was hit — the report must disclose partial coverage. */
  truncated: boolean;
  /** Files skipped because they exceed maxFileBytes. */
  oversized: string[];
}

/**
 * Walk the checkout collecting analyzable files.
 *
 * Symlinks are never followed. On an extracted archive they are already stripped,
 * but a cloned repo can contain them and following one can walk out of the repo
 * or into a cycle.
 */
export async function walkRepo(rootPath: string): Promise<WalkResult> {
  /*
   * Two passes, and the split is the whole point.
   *
   * The single-pass version applied the size and count caps *during* traversal
   * and returned early when one bit — before the sort at the bottom. So on any
   * repository large enough to truncate, the subset analysed was whichever
   * files the depth-first walk happened to reach first, which depends on
   * `readdir` order and therefore on the filesystem. Two scans of the same
   * repository could analyse different files and produce different scores,
   * against a README whose central claim is that the same repository always
   * produces the same report.
   *
   * Collecting candidates first and sorting *before* the caps are applied makes
   * the truncated subset a deterministic prefix: the same repository yields the
   * same files whether it is read from a local checkout or an extracted
   * tarball on a different platform.
   */
  const candidates = await collectCandidates(rootPath);

  // Stable ordering keeps scan output deterministic across filesystems — and
  // now also decides *which* files survive truncation, not merely their order.
  candidates.sort((a, b) =>
    a.relPath < b.relPath ? -1 : a.relPath > b.relPath ? 1 : 0,
  );

  const files: WalkedFile[] = [];
  const oversized: string[] = [];
  let truncated = false;
  let totalBytes = 0;

  for (const candidate of candidates) {
    if (files.length >= LIMITS.maxFiles) {
      truncated = true;
      break;
    }

    /*
     * Deferred to here rather than done during collection: stat is the
     * expensive part of the walk, and in sorted order we only pay for files we
     * are actually going to read.
     */
    let sizeBytes: number;
    try {
      sizeBytes = (await stat(candidate.absPath)).size;
    } catch {
      continue;
    }

    if (sizeBytes > LIMITS.maxFileBytes) {
      oversized.push(candidate.relPath);
      continue;
    }

    totalBytes += sizeBytes;
    if (totalBytes > LIMITS.maxTotalBytes) {
      truncated = true;
      break;
    }

    files.push({ ...candidate, sizeBytes });
  }

  return { files, truncated, oversized };
}

/** Every relevant path in the tree, unsorted and unstatted. */
async function collectCandidates(
  rootPath: string,
): Promise<{ relPath: string; absPath: string }[]> {
  const candidates: { relPath: string; absPath: string }[] = [];
  const queue: string[] = [rootPath];

  while (queue.length > 0) {
    const dir = queue.pop()!;
    let entries;
    try {
      entries = await readdir(dir, { withFileTypes: true });
    } catch {
      // Unreadable directory (permissions, race with cleanup) — skip it.
      continue;
    }

    for (const entry of entries) {
      if (entry.isSymbolicLink()) continue;

      const absPath = path.join(dir, entry.name);

      if (entry.isDirectory()) {
        // .git is walked by the git indexer via git itself, not by reading blobs.
        if (entry.name === ".git" || IGNORED_DIRS.has(entry.name)) continue;
        queue.push(absPath);
        continue;
      }

      if (!entry.isFile()) continue;

      const relPath = normalizePath(path.relative(rootPath, absPath));
      if (!isRelevantFile(relPath)) continue;

      candidates.push({ relPath, absPath });
    }
  }

  return candidates;
}

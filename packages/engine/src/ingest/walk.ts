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
  const files: WalkedFile[] = [];
  const oversized: string[] = [];
  let truncated = false;
  let totalBytes = 0;

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

      if (files.length >= LIMITS.maxFiles) {
        truncated = true;
        return { files, truncated, oversized };
      }

      let sizeBytes: number;
      try {
        sizeBytes = (await stat(absPath)).size;
      } catch {
        continue;
      }

      if (sizeBytes > LIMITS.maxFileBytes) {
        oversized.push(relPath);
        continue;
      }

      totalBytes += sizeBytes;
      if (totalBytes > LIMITS.maxTotalBytes) {
        truncated = true;
        return { files, truncated, oversized };
      }

      files.push({ relPath, absPath, sizeBytes });
    }
  }

  // Stable ordering keeps scan output deterministic across filesystems.
  files.sort((a, b) => (a.relPath < b.relPath ? -1 : a.relPath > b.relPath ? 1 : 0));
  return { files, truncated, oversized };
}

import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import path from "node:path";
import { promisify } from "node:util";

import { normalizePath } from "../ingest/guards";

const run = promisify(execFile);

export interface CommitFileChange {
  relPath: string;
  added: number;
  deleted: number;
}

export interface Commit {
  sha: string;
  authorName: string;
  authorEmail: string;
  /** Epoch milliseconds, author date. */
  timestamp: number;
  subject: string;
  body: string;
  files: CommitFileChange[];
  /** Sum of added + deleted across the commit. */
  churn: number;
}

/**
 * Git history for the repo under analysis.
 *
 * When history is unavailable — a zip upload with no `.git`, or a repo with a
 * single commit — `available` is false. Consumers must degrade the provenance
 * score's *confidence* rather than treating missing history as a clean signal.
 */
export class GitIndex {
  readonly available: boolean;
  readonly unavailableReason?: string;
  readonly commits: Commit[];
  readonly warnings: string[] = [];
  /**
   * Whether per-file change data is present for every commit.
   *
   * True for a local repo, where `git log --numstat` gives it for free. Possibly
   * false when history comes from the GitHub API, which omits stats from the
   * commit list and requires a request per commit. Signals needing completeness
   * — which files were touched exactly once — must degrade rather than compute a
   * biased answer over a sample.
   */
  readonly statsComplete: boolean;

  private constructor(
    available: boolean,
    commits: Commit[],
    unavailableReason?: string,
    statsComplete = true,
  ) {
    this.available = available;
    this.commits = commits;
    if (unavailableReason) this.unavailableReason = unavailableReason;
    this.statsComplete = statsComplete;
  }

  /**
   * Build from commits obtained somewhere other than a local checkout — the
   * GitHub API today.
   *
   * `Commit[]` is the seam the provenance analyzer sits on: every signal reads
   * only that array, so changing where history comes from changes no analyzer.
   */
  static fromCommits(
    commits: Commit[],
    options: { statsComplete?: boolean; truncated?: boolean } = {},
  ): GitIndex {
    if (commits.length === 0) {
      return new GitIndex(false, [], "no commit history available");
    }

    const index = new GitIndex(
      true,
      commits,
      undefined,
      options.statsComplete ?? true,
    );

    if (commits.length < 3) {
      index.warnings.push(
        `only ${commits.length} commit(s) — history-based signals are weak`,
      );
    }
    if (options.truncated) {
      index.warnings.push(
        "commit history was long enough to be truncated; distribution signals cover the most recent commits only",
      );
    }
    if (options.statsComplete === false) {
      index.warnings.push(
        "per-file change data was unavailable for some commits",
      );
    }
    return index;
  }

  static async build(rootPath: string): Promise<GitIndex> {
    if (!existsSync(path.join(rootPath, ".git"))) {
      return new GitIndex(false, [], "no git history in the uploaded source");
    }

    let raw: string;
    try {
      raw = await gitLog(rootPath);
    } catch (err) {
      return new GitIndex(false, [], `git log failed: ${String(err).slice(0, 200)}`);
    }

    const commits = parseGitLog(raw);
    if (commits.length === 0) {
      return new GitIndex(false, [], "repository has no commits");
    }
    // A single squashed commit carries no distributional information.
    if (commits.length < 3) {
      const idx = new GitIndex(true, commits);
      idx.warnings.push(
        `only ${commits.length} commit(s) — history-based signals are weak`,
      );
      return idx;
    }
    return new GitIndex(true, commits);
  }

  get commitCount(): number {
    return this.commits.length;
  }

  /** Distinct author emails, lowercased. */
  authors(): string[] {
    return [...new Set(this.commits.map((c) => c.authorEmail.toLowerCase()))];
  }

  /** Commits ordered oldest → newest. */
  chronological(): Commit[] {
    return [...this.commits].sort((a, b) => a.timestamp - b.timestamp);
  }

  /** Span of the project's history in days. */
  activeDays(): number {
    if (this.commits.length === 0) return 0;
    const days = new Set(
      this.commits.map((c) => new Date(c.timestamp).toISOString().slice(0, 10)),
    );
    return days.size;
  }

  /** Commits that touched a given file, newest first. */
  commitsTouching(relPath: string): Commit[] {
    return this.commits.filter((c) => c.files.some((f) => f.relPath === relPath));
  }

  /**
   * Files created in one commit and never modified again — a strong tell for
   * generated scaffolding that was never revisited.
   */
  writeOnceFiles(): string[] {
    const counts = new Map<string, number>();
    for (const c of this.commits) {
      for (const f of c.files) {
        counts.set(f.relPath, (counts.get(f.relPath) ?? 0) + 1);
      }
    }
    return [...counts.entries()].filter(([, n]) => n === 1).map(([p]) => p);
  }
}

const NUL = "\x00";
const UNIT = "\x1f";
const RECORD = "\x1e";

async function gitLog(cwd: string): Promise<string> {
  // Separators are written as git's own %xNN escapes, not literal control bytes:
  // Node's child_process rejects any argument containing a NUL byte, so the
  // format string must stay plain ASCII and let git emit the delimiters.
  const format = ["%x00%H", "%an", "%ae", "%at", "%s", "%B%x1e"].join("%x1f");

  const { stdout } = await run(
    "git",
    [
      "log",
      "--no-merges",
      "--numstat",
      "--no-renames",
      `--pretty=format:${format}`,
    ],
    {
      cwd,
      maxBuffer: 256 << 20,
      // Large histories are slow; cap rather than hang a worker.
      timeout: 120_000,
    },
  );
  return stdout;
}

export function parseGitLog(raw: string): Commit[] {
  const commits: Commit[] = [];

  for (const chunk of raw.split(NUL)) {
    if (chunk.trim() === "") continue;

    const recordSplit = chunk.indexOf(RECORD);
    if (recordSplit === -1) continue;

    const header = chunk.slice(0, recordSplit);
    const numstat = chunk.slice(recordSplit + 1);

    const parts = header.split(UNIT);
    if (parts.length < 6) continue;

    const [sha, authorName, authorEmail, at, subject, body] = parts as [
      string,
      string,
      string,
      string,
      string,
      string,
    ];

    const files: CommitFileChange[] = [];
    let churn = 0;
    for (const line of numstat.split("\n")) {
      const trimmed = line.trim();
      if (trimmed === "") continue;
      const cols = trimmed.split("\t");
      if (cols.length < 3) continue;
      // Binary files report "-" for both counts.
      const added = cols[0] === "-" ? 0 : Number.parseInt(cols[0]!, 10) || 0;
      const deleted = cols[1] === "-" ? 0 : Number.parseInt(cols[1]!, 10) || 0;
      files.push({ relPath: normalizePath(cols[2]!), added, deleted });
      churn += added + deleted;
    }

    commits.push({
      sha,
      authorName,
      authorEmail,
      timestamp: (Number.parseInt(at, 10) || 0) * 1000,
      subject,
      body,
      files,
      churn,
    });
  }

  return commits;
}

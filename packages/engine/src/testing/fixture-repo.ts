import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

/** A commit to synthesize: files written, then committed with this message. */
export interface FixtureCommit {
  message: string;
  files: Record<string, string>;
  authorName?: string;
  authorEmail?: string;
  /** ISO date; defaults to a fixed base date so tests stay deterministic. */
  date?: string;
}

export interface FixtureRepo {
  rootPath: string;
  cleanup(): void;
}

/** Fixed base so commit-timing signals are reproducible across runs. */
const BASE_DATE = new Date("2025-01-15T10:00:00Z");

/**
 * Build a throwaway git repository on disk for analyzer tests.
 *
 * Tests that only need files (no history) can pass `commits: []` and use `files`,
 * which mirrors the zip-upload path where `.git` is absent.
 */
export function createFixtureRepo(opts: {
  files?: Record<string, string>;
  commits?: FixtureCommit[];
  /** Omit git entirely — models a zip upload. */
  withoutGit?: boolean;
}): FixtureRepo {
  const rootPath = mkdtempSync(path.join(tmpdir(), "vibe-fixture-"));

  const cleanup = () => rmSync(rootPath, { recursive: true, force: true });

  const writeAll = (files: Record<string, string>) => {
    for (const [rel, content] of Object.entries(files)) {
      const abs = path.join(rootPath, rel);
      mkdirSync(path.dirname(abs), { recursive: true });
      writeFileSync(abs, content);
    }
  };

  if (opts.files) writeAll(opts.files);

  if (opts.withoutGit || !opts.commits || opts.commits.length === 0) {
    if (!opts.withoutGit && opts.commits?.length === 0) {
      // Explicit empty commit list still means "no history".
    }
    return { rootPath, cleanup };
  }

  const git = (args: string[], env?: NodeJS.ProcessEnv) =>
    execFileSync("git", args, {
      cwd: rootPath,
      stdio: "pipe",
      env: { ...process.env, ...env },
    });

  git(["init", "-q", "-b", "main"]);
  git(["config", "user.email", "dev@example.com"]);
  git(["config", "user.name", "Dev"]);
  git(["config", "commit.gpgsign", "false"]);

  opts.commits.forEach((commit, i) => {
    writeAll(commit.files);
    git(["add", "-A"]);
    const when =
      commit.date ?? new Date(BASE_DATE.getTime() + i * 3_600_000).toISOString();
    git(
      [
        "-c",
        `user.name=${commit.authorName ?? "Dev"}`,
        "-c",
        `user.email=${commit.authorEmail ?? "dev@example.com"}`,
        "commit",
        "-q",
        "--no-verify",
        "-m",
        commit.message,
      ],
      { GIT_AUTHOR_DATE: when, GIT_COMMITTER_DATE: when },
    );
  });

  return { rootPath, cleanup };
}

import { describe, expect, it } from "vitest";

import { buildContext } from "../scan";
import { createFixtureRepo } from "../testing/fixture-repo";
import {
  buildVelocitySignal,
  commitSizeSignal,
  writeOnceFilesSignal,
} from "../analyzers/provenance/commit-shape";
import { GitIndex, type Commit } from "./git";

/**
 * `Commit[]` is the seam between where history comes from and every analyzer
 * that reads it. These cover the second source (the GitHub API), which supplies
 * less than `git log` does — and must say so rather than quietly guessing.
 */

function commit(overrides: Partial<Commit> = {}): Commit {
  return {
    sha: "a".repeat(40),
    authorName: "Dev",
    authorEmail: "dev@example.com",
    timestamp: Date.UTC(2025, 0, 15),
    subject: "feat: add a thing",
    body: "feat: add a thing",
    files: [],
    churn: 40,
    ...overrides,
  };
}

function manyCommits(count: number, churn = 40): Commit[] {
  return Array.from({ length: count }, (_, i) =>
    commit({
      sha: String(i).padStart(40, "0"),
      subject: `feat: change ${i}`,
      body: `feat: change ${i}`,
      timestamp: Date.UTC(2025, 0, 1 + i),
      churn,
    }),
  );
}

describe("GitIndex.fromCommits", () => {
  it("is unavailable when there are no commits", () => {
    const index = GitIndex.fromCommits([]);
    expect(index.available).toBe(false);
    expect(index.unavailableReason).toMatch(/no commit history/);
  });

  it("warns rather than failing on a very short history", () => {
    const index = GitIndex.fromCommits([commit()]);
    expect(index.available).toBe(true);
    expect(index.warnings.join(" ")).toMatch(/history-based signals are weak/);
  });

  it("records incomplete stats and truncation as warnings", () => {
    const index = GitIndex.fromCommits(manyCommits(10), {
      statsComplete: false,
      truncated: true,
    });

    expect(index.statsComplete).toBe(false);
    expect(index.warnings.join(" ")).toMatch(/per-file change data was unavailable/);
    expect(index.warnings.join(" ")).toMatch(/truncated/);
  });

  it("defaults to complete stats, matching a local checkout", () => {
    expect(GitIndex.fromCommits(manyCommits(10)).statsComplete).toBe(true);
  });
});

describe("signals degrade honestly on API-sourced history", () => {
  async function contextWith(git: GitIndex) {
    const repo = createFixtureRepo({
      files: {
        // buildVelocitySignal needs at least 200 lines of source before it will
        // judge a codebase, so the fixture has to clear that bar.
        "src/a.ts": Array.from(
          { length: 250 },
          (_, i) => `export const value${i} = ${i};`,
        ).join("\n"),
        "package.json": `{"name":"x"}`,
      },
      withoutGit: true,
    });
    try {
      return await buildContext(repo.rootPath, { git });
    } finally {
      repo.cleanup();
    }
  }

  it("marks write-once-files unavailable when per-file data is incomplete", async () => {
    // Computed over a sample it would report files as write-once purely because
    // the commit that changed them again was never fetched.
    const ctx = await contextWith(
      GitIndex.fromCommits(manyCommits(30), { statsComplete: false }),
    );
    const signal = writeOnceFilesSignal(ctx);

    expect(signal.available).toBe(false);
    expect(signal.unavailableReason).toMatch(/incomplete/);
    expect(signal.value).toBe(0);
  });

  it("distinguishes 'no line counts available' from 'no sizeable commits'", async () => {
    // The REST commits endpoint reports no additions/deletions at all. That is a
    // gap in our data, not a property of the repository.
    const ctx = await contextWith(GitIndex.fromCommits(manyCommits(30, 0)));
    const signal = commitSizeSignal(ctx);

    expect(signal.available).toBe(false);
    expect(signal.unavailableReason).toMatch(/line counts are unavailable/);
  });

  it("still computes commit size when churn is present", async () => {
    const ctx = await contextWith(GitIndex.fromCommits(manyCommits(30, 900)));
    const signal = commitSizeSignal(ctx);

    expect(signal.available).toBe(true);
    expect(signal.value).toBeGreaterThan(0.5);
    expect(signal.evidence.join(" ")).toMatch(/Median commit changes 900 lines/);
  });

  it("still computes velocity, which never needed per-file data", async () => {
    const ctx = await contextWith(GitIndex.fromCommits(manyCommits(30)));
    const signal = buildVelocitySignal(ctx);

    expect(signal.available).toBe(true);
    expect(signal.evidence.join(" ")).toMatch(/day\(s\) of commits/);
  });
});

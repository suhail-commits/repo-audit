import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { LIMITS } from "./guards";
import { walkRepo } from "./walk";

let root: string | undefined;
afterEach(() => {
  if (root) rmSync(root, { recursive: true, force: true });
  root = undefined;
});

/** A tree spread across several directories, so traversal order is in play. */
function buildTree(fileCount: number, bytesEach: number): string {
  const dir = mkdtempSync(path.join(tmpdir(), "walk-test-"));
  const body = "x".repeat(Math.max(0, bytesEach - 1)) + "\n";

  for (let i = 0; i < fileCount; i++) {
    const sub = path.join(dir, `pkg${String(i % 7)}`, "src");
    mkdirSync(sub, { recursive: true });
    writeFileSync(path.join(sub, `mod${String(i).padStart(4, "0")}.ts`), body);
  }
  return dir;
}

describe("walkRepo", () => {
  it("returns files in a stable order", async () => {
    root = buildTree(40, 100);
    const paths = (await walkRepo(root)).files.map((f) => f.relPath);
    expect([...paths].sort()).toEqual(paths);
  });

  /*
   * The bug this test exists for.
   *
   * The caps used to be applied *during* traversal, with an early return that
   * skipped the sort at the bottom of the function. So on any repository large
   * enough to truncate, the subset analysed was whichever files the
   * depth-first walk reached first — which depends on `readdir` order and
   * therefore on the filesystem. Two scans of the same repository could analyse
   * different files and produce different scores, against a README whose
   * central claim is that the same repository always produces the same report.
   *
   * Sorting the candidates *before* applying the caps makes the surviving
   * subset a deterministic prefix rather than an accident of traversal.
   */
  it("truncates to a deterministic prefix, not to whatever it reached first", async () => {
    // Comfortably past the byte cap, spread across directories.
    const perFile = 200_000;
    const needed = Math.ceil(LIMITS.maxTotalBytes / perFile) + 20;
    root = buildTree(needed, perFile);

    const first = await walkRepo(root);
    const second = await walkRepo(root);

    expect(first.truncated).toBe(true);
    expect(second.truncated).toBe(true);
    expect(first.files.map((f) => f.relPath)).toEqual(
      second.files.map((f) => f.relPath),
    );

    // A prefix of the sorted candidate list — the property that makes it
    // reproducible on a different filesystem, not merely on this one.
    const kept = first.files.map((f) => f.relPath);
    expect([...kept].sort()).toEqual(kept);
  }, 60_000);

  it("stays under the byte cap it truncated for", async () => {
    const perFile = 200_000;
    const needed = Math.ceil(LIMITS.maxTotalBytes / perFile) + 20;
    root = buildTree(needed, perFile);

    const result = await walkRepo(root);
    const total = result.files.reduce((sum, f) => sum + f.sizeBytes, 0);
    expect(total).toBeLessThanOrEqual(LIMITS.maxTotalBytes);
  }, 60_000);

  it("does not report truncation for a repository that fits", async () => {
    root = buildTree(12, 500);
    const result = await walkRepo(root);

    // The silent case: truncation now lowers every dimension's confidence, so
    // a false positive here would quietly devalue every ordinary scan.
    expect(result.truncated).toBe(false);
    expect(result.files).toHaveLength(12);
  });

  it("skips a file past the per-file cap without truncating the walk", async () => {
    root = buildTree(3, 100);
    writeFileSync(
      path.join(root, "huge.ts"),
      "y".repeat(LIMITS.maxFileBytes + 10),
    );

    const result = await walkRepo(root);
    expect(result.oversized).toEqual(["huge.ts"]);
    expect(result.truncated).toBe(false);
    expect(result.files.map((f) => f.relPath)).not.toContain("huge.ts");
  });
});

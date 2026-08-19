import { describe, expect, it } from "vitest";

import type { Signal } from "@vibe/shared";

import { computeHotspots } from "./hotspots";

function signal(overrides: Partial<Signal> = {}): Signal {
  return {
    id: "duplicate-logic",
    value: 0.5,
    weight: 2,
    available: true,
    evidence: [],
    ...overrides,
  };
}

/** `n` files under `dir`, named predictably. */
function filesIn(dir: string, n: number): string[] {
  return Array.from({ length: n }, (_, i) => `${dir}/file${i}.ts`);
}

describe("computeHotspots", () => {
  it("returns nothing when no available signal carries per-file data", () => {
    const ranked = computeHotspots(
      [signal({ perFile: undefined }), signal({ id: "agent-trailers" })],
      { sourceFiles: filesIn("src", 10) },
    );
    expect(ranked).toEqual([]);
  });

  it("ignores per-file data on a signal that is unavailable", () => {
    // An unavailable signal contributes nothing to the score, so letting it
    // steer the ranking would make the two disagree about the same evidence.
    const ranked = computeHotspots(
      [
        signal({
          available: false,
          unavailableReason: "no git history",
          perFile: { "src/a/file0.ts": 1 },
        }),
      ],
      { sourceFiles: filesIn("src/a", 5) },
    );
    expect(ranked).toEqual([]);
  });

  it("ranks by density, not by how much code a directory holds", () => {
    const ranked = computeHotspots(
      [
        signal({
          perFile: {
            // Every file in the small directory, a handful in the large one.
            ...Object.fromEntries(filesIn("src/small", 4).map((f) => [f, 1])),
            ...Object.fromEntries(filesIn("src/large", 4).map((f) => [f, 1])),
          },
        }),
      ],
      { sourceFiles: [...filesIn("src/small", 4), ...filesIn("src/large", 40)] },
    );

    expect(ranked[0]!.path).toBe("src/small");
    expect(ranked[0]!.intensity).toBe(1);
    expect(ranked[1]!.path).toBe("src/large");
    expect(ranked[1]!.intensity).toBeLessThan(0.5);
  });

  it("folds a directory too small to judge into its parent", () => {
    const ranked = computeHotspots(
      [
        signal({
          perFile: {
            "src/api/scans/route.ts": 1,
            "src/other/file0.ts": 0.2,
          },
        }),
      ],
      {
        sourceFiles: [
          "src/api/scans/route.ts",
          ...filesIn("src/api", 3),
          ...filesIn("src/other", 3),
        ],
      },
    );

    // `src/api/scans` never appears in its own right; its file is counted
    // toward the parent, which is the bucket big enough to mean something.
    expect(ranked.map((r) => r.path)).toEqual(["src/api", "src/other"]);
    expect(ranked[0]!.files).toBe(4);
  });

  it("folds through a directory that holds no files of its own", () => {
    /*
     * `src/app/api` holds nothing directly and only receives `api/scans`'s one
     * file. An earlier version built its work list from directories with direct
     * files only, so such a directory never got its turn to merge onward and
     * survived as a one-file bucket — ranked first, because one implicated file
     * over a denominator of one is the strongest density possible.
     */
    const ranked = computeHotspots(
      [
        signal({
          perFile: {
            "src/app/api/scans/route.ts": 1,
            "src/other/file0.ts": 0.2,
          },
        }),
      ],
      {
        sourceFiles: [
          "src/app/api/scans/route.ts",
          ...filesIn("src/app", 3),
          ...filesIn("src/other", 3),
        ],
      },
    );

    expect(ranked.map((r) => r.path)).toEqual(["src/app", "src/other"]);
    expect(ranked[0]!.files).toBe(4);
  });

  it("shows nothing when there is only one directory to rank", () => {
    /*
     * Seen on `sindresorhus/p-limit`, where every source file sits at the repo
     * root: the section rendered a single bar at full length labelled `.`,
     * which says the signs are strongest in the only place there is.
     */
    const ranked = computeHotspots(
      [
        signal({
          perFile: Object.fromEntries(filesIn("src", 4).map((f) => [f, 1])),
        }),
      ],
      { sourceFiles: filesIn("src", 4) },
    );
    expect(ranked).toEqual([]);
  });

  it("drops a bucket that is still too small after folding", () => {
    // Two files at the repo root cannot merge anywhere. They are counted in the
    // score either way; what they are not is a concentration worth naming.
    const ranked = computeHotspots(
      [signal({ perFile: { "root0.ts": 1, "root1.ts": 1 } })],
      { sourceFiles: ["root0.ts", "root1.ts"] },
    );
    expect(ranked).toEqual([]);
  });

  it("weights each signal by its share, as the scorer does", () => {
    const ranked = computeHotspots(
      [
        signal({
          id: "duplicate-logic",
          weight: 3,
          perFile: Object.fromEntries(filesIn("src/heavy", 3).map((f) => [f, 1])),
        }),
        signal({
          id: "obvious-comments",
          weight: 1,
          perFile: Object.fromEntries(filesIn("src/light", 3).map((f) => [f, 1])),
        }),
      ],
      { sourceFiles: [...filesIn("src/heavy", 3), ...filesIn("src/light", 3)] },
    );

    expect(ranked[0]!.path).toBe("src/heavy");
    // 3:1 weights over equal per-file values and equal file counts.
    expect(ranked[1]!.intensity).toBeCloseTo(1 / 3, 5);
  });

  it("names the signals that implicated a directory, strongest first", () => {
    const ranked = computeHotspots(
      [
        signal({
          id: "obvious-comments",
          weight: 1,
          perFile: Object.fromEntries(filesIn("src/a", 3).map((f) => [f, 1])),
        }),
        signal({
          id: "duplicate-logic",
          weight: 3,
          perFile: {
            ...Object.fromEntries(filesIn("src/a", 3).map((f) => [f, 1])),
            "src/b/file0.ts": 0.1,
          },
        }),
      ],
      { sourceFiles: [...filesIn("src/a", 3), ...filesIn("src/b", 3)] },
    );

    expect(ranked[0]!.path).toBe("src/a");
    expect(ranked[0]!.signals).toEqual(["duplicate-logic", "obvious-comments"]);
  });

  it("skips per-file entries for files outside the source set", () => {
    // A test file can be implicated by `tautological-tests` while not counting
    // toward any directory's denominator. Including it would credit a
    // directory with a numerator its denominator never saw.
    const ranked = computeHotspots(
      [
        signal({
          perFile: {
            "test/helper.test.ts": 1,
            ...Object.fromEntries(filesIn("src/a", 3).map((f) => [f, 0.5])),
            "src/b/file0.ts": 0.1,
          },
        }),
      ],
      { sourceFiles: [...filesIn("src/a", 3), ...filesIn("src/b", 3)] },
    );

    expect(ranked.map((r) => r.path)).toEqual(["src/a", "src/b"]);
  });
});

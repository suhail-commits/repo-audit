import { afterEach, describe, expect, it } from "vitest";

import { buildContext } from "../../scan";
import {
  createFixtureRepo,
  type FixtureCommit,
  type FixtureRepo,
} from "../../testing/fixture-repo";
import { refactorRatioSignal } from "./rework";

let repo: FixtureRepo | undefined;
afterEach(() => {
  repo?.cleanup();
  repo = undefined;
});

async function signalFor(commits: FixtureCommit[]) {
  repo = createFixtureRepo({ commits });
  const ctx = await buildContext(repo.rootPath);
  return refactorRatioSignal(ctx);
}

/** One line per index, so a file's length is exactly `lines`. */
const body = (lines: number, seed = 0) =>
  Array.from({ length: lines }, (_, i) => `const v${seed}_${i} = ${i};`).join(
    "\n",
  ) + "\n";

/** A day apart, so a run of commits also produces a run of active days. */
const dayOf = (n: number) =>
  new Date(Date.UTC(2025, 0, 1 + n, 12, 0, 0)).toISOString();

describe("refactor-ratio", () => {
  it("fires on a history that only ever adds", async () => {
    /*
     * The positive side, which the sweep corpus cannot supply — it contains
     * only hand-written code. A structural signal can be proved in this
     * direction with a fixture, which is the difference between this and
     * `doc-style`: prose had no way to test the firing case at all.
     */
    const commits: FixtureCommit[] = Array.from({ length: 60 }, (_, i) => ({
      message: `add module ${i}`,
      // A brand new file each time and nothing ever removed.
      files: { [`src/mod${i}.ts`]: body(30, i) },
      date: dayOf(i),
    }));

    const signal = await signalFor(commits);

    expect(signal.available).toBe(true);
    expect(signal.value).toBeGreaterThan(0.9);
  });

  it("stays silent on a history that deletes as it goes", async () => {
    /*
     * The case that matters. Each commit rewrites the same file at the same
     * length, so deletions are about half of churn — which is where all 20
     * hand-written sweep repositories actually sit (0.333-0.500).
     */
    const commits: FixtureCommit[] = Array.from({ length: 60 }, (_, i) => ({
      message: `rework module ${i}`,
      files: { "src/core.ts": body(40, i) },
      date: dayOf(i),
    }));

    const signal = await signalFor(commits);

    expect(signal.available).toBe(true);
    expect(signal.value).toBe(0);
  });

  it("reports unavailable on a short history rather than judging it", async () => {
    /*
     * This repository reads 0.085 — truthfully, because it is twenty commits
     * across two days and nothing has yet had reason to be deleted. Without
     * this guard a young hand-written project scores as generated, which is
     * the mistake `build-velocity` made by dividing by a single active day.
     */
    const commits: FixtureCommit[] = Array.from({ length: 20 }, (_, i) => ({
      message: `add module ${i}`,
      files: { [`src/mod${i}.ts`]: body(30, i) },
      date: dayOf(i),
    }));

    const signal = await signalFor(commits);

    expect(signal.available).toBe(false);
    expect(signal.unavailableReason).toMatch(/too short a history/i);
    // Invariant 2: unavailable, never a value of 0.
    expect(signal.value).toBe(0);
  });

  it("reports unavailable when a long history lands in a few days", async () => {
    // Enough commits, no span. A weekend of 60 commits has had no more
    // occasion to refactor than a weekend of 6.
    const commits: FixtureCommit[] = Array.from({ length: 60 }, (_, i) => ({
      message: `add module ${i}`,
      files: { [`src/mod${i}.ts`]: body(30, i) },
      date: dayOf(i % 3),
    }));

    const signal = await signalFor(commits);

    expect(signal.available).toBe(false);
    expect(signal.unavailableReason).toMatch(/active day/i);
  });

  it("reports unavailable with no git history at all", async () => {
    repo = createFixtureRepo({
      files: { "src/index.ts": body(10) },
      withoutGit: true,
    });
    const ctx = await buildContext(repo.rootPath);

    expect(refactorRatioSignal(ctx).available).toBe(false);
  });
});

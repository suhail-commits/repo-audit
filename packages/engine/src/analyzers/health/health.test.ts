import { afterEach, describe, expect, it } from "vitest";

import { buildContext } from "../../scan";
import { createFixtureRepo, type FixtureRepo } from "../../testing/fixture-repo";
import { analyzeAuthorship } from "../authorship/index";
import { analyzeHealth, SHARED_SIGNAL_IDS, WEIGHTS } from "./index";

let repo: FixtureRepo | undefined;
afterEach(() => {
  repo?.cleanup();
  repo = undefined;
});

async function healthOf(files: Record<string, string>) {
  repo = createFixtureRepo({ files, withoutGit: true });
  const ctx = await buildContext(repo.rootPath);
  const authorship = analyzeAuthorship(ctx);
  return {
    authorship,
    health: analyzeHealth(ctx, authorship.score.signals).score,
  };
}

const MODULES = ["alpha", "beta", "gamma", "delta", "epsilon", "zeta"];
const PER_MODULE = 4;

/**
 * One function whose *structure* depends on `variant`, so no two are clones.
 *
 * The statement count is what varies, and it has to vary monotonically. An
 * earlier version used `variant % 3`, which produced three shapes across
 * twenty-four functions — clone detection normalises identifiers and literals
 * away, so differing names and numbers made no difference at all and the
 * "tidy" fixture scored 35 on duplication.
 */
function distinctFunction(name: string, variant: number): string {
  return [
    `export function ${name}(base: number = ${variant + 2}): number {`,
    `  const scaled = compute(base) * ${variant + 1};`,
    `  let shifted = scaled + ${variant * 7};`,
    ...Array.from(
      { length: variant + 1 },
      (_, k) => `  if (shifted > ${k * 5}) shifted -= ${k + variant};`,
    ),
    `  return shifted;`,
    `}`,
  ].join("\n");
}

/**
 * A tidy project: every module imported, every module tested, no duplication.
 *
 * Deliberately above the thresholds the signals need. `test-coverage` ignores
 * repositories under five source files, and **`duplicate-logic` reports
 * unavailable below twenty functions** — the first version of this fixture had
 * seven, so the duplication assertion was comparing two scores that could not
 * have differed. A fixture under a threshold proves nothing: the signal would
 * have stayed quiet whatever the code looked like.
 */
function tidyProject(): Record<string, string> {
  const files: Record<string, string> = {
    "package.json": JSON.stringify({
      name: "tidy",
      dependencies: { "used-lib": "^1.0.0" },
    }),
    "src/index.ts": [
      ...MODULES.map((n) => `import { ${n}0 } from './${n}';`),
      `export const run = () => ${MODULES.map((n) => `${n}0()`).join(" + ")};`,
    ].join("\n"),
  };

  for (const [i, name] of MODULES.entries()) {
    files[`src/${name}.ts`] = [
      `import lib from 'used-lib';`,
      `function compute(n: number): number { return lib(n); }`,
      ...Array.from({ length: PER_MODULE }, (_, k) =>
        distinctFunction(`${name}${k}`, i * PER_MODULE + k),
      ),
    ].join("\n");

    files[`test/${name}.test.ts`] = [
      `import { ${name}0 } from '../src/${name}';`,
      `import { expect, it } from 'vitest';`,
      `it('${name} scales', () => { expect(${name}0()).toBeGreaterThan(0) });`,
    ].join("\n");
  }

  return files;
}

describe("code health", () => {
  it("stays near zero on a tidy, tested project", async () => {
    const { health } = await healthOf(tidyProject());

    // The silent case is the one that matters: this dimension is rendered as a
    // score with a band, so a tidy repo landing outside "solid" is a false
    // positive a reader would see immediately.
    expect(health.score).toBeLessThan(25);
  });

  it("reports missing tests rather than staying silent about them", async () => {
    const untested = tidyProject();
    for (const key of Object.keys(untested)) {
      if (key.startsWith("test/")) delete untested[key];
    }

    const { health } = await healthOf(untested);
    const coverage = health.signals.find((s) => s.id === "test-coverage")!;

    expect(coverage.available).toBe(true);
    expect(coverage.value).toBe(1);
    expect(coverage.evidence.join(" ")).toContain("No test files found");
  });

  it("scores worse when the same logic is written repeatedly", async () => {
    const duplicated = tidyProject();
    // The same body under twelve names — identical structure, different
    // identifiers, which is exactly what type-2 clone detection looks for.
    for (const name of ["delta", "epsilon", "zeta"]) {
      duplicated[`src/${name}.ts`] = [
        `import lib from 'used-lib';`,
        `function compute(n: number): number { return lib(n); }`,
        ...Array.from({ length: PER_MODULE }, (_, k) =>
          distinctFunction(`${name}${k}`, 1),
        ),
      ].join("\n");
    }

    const tidy = await healthOf(tidyProject());
    const messy = await healthOf(duplicated);

    expect(messy.health.score).toBeGreaterThan(tidy.health.score);
  });

  it("re-weights the shared signals instead of recomputing them", async () => {
    /*
     * The same measurement appears in two sections. If health ever recomputed
     * rather than borrowed, the two could print different numbers for the same
     * thing — the failure this test exists to prevent.
     */
    const { authorship, health } = await healthOf(tidyProject());

    for (const id of SHARED_SIGNAL_IDS) {
      const from = authorship.score.signals.find((s) => s.id === id)!;
      const to = health.signals.find((s) => s.id === id)!;

      expect(to.value).toBe(from.value);
      expect(to.available).toBe(from.available);
      expect(to.weight).toBe(WEIGHTS[id]);
    }
  });

  it("marks a borrowed signal unavailable rather than dropping it", async () => {
    repo = createFixtureRepo({ files: tidyProject(), withoutGit: true });
    const ctx = await buildContext(repo.rootPath);

    // Simulates the authorship pass no longer emitting one. Dropping it would
    // silently redistribute its weight and raise every other signal's share.
    const health = analyzeHealth(ctx, []).score;
    const borrowed = health.signals.filter((s) =>
      (SHARED_SIGNAL_IDS as readonly string[]).includes(s.id),
    );

    expect(borrowed).toHaveLength(SHARED_SIGNAL_IDS.length);
    expect(borrowed.every((s) => !s.available)).toBe(true);
  });
});

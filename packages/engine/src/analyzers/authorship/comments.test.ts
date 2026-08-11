import { afterEach, describe, expect, it } from "vitest";

import { buildContext } from "../../scan";
import { createFixtureRepo, type FixtureRepo } from "../../testing/fixture-repo";
import { tautologicalTestSignal } from "./comments";

let repo: FixtureRepo | undefined;
afterEach(() => {
  repo?.cleanup();
  repo = undefined;
});

async function signalFor(files: Record<string, string>) {
  repo = createFixtureRepo({ files, withoutGit: true });
  return tautologicalTestSignal(await buildContext(repo.rootPath));
}

/** Enough cases to clear the signal's minimum sample size. */
function repeat(template: (i: number) => string, count = 6): string {
  return Array.from({ length: count }, (_, i) => template(i)).join("\n\n");
}

describe("tautological test detection", () => {
  it("recognises AVA-style assertions on the test context", async () => {
    // Seen on sindresorhus/p-limit: counting only `expect(...)` reported every
    // one of its AVA tests as asserting nothing.
    const signal = await signalFor({
      "test.js": repeat(
        (i) => `test('case ${i}', async (t) => {
  const result = await run(${i});
  t.is(result, ${i});
});`,
      ),
    });

    expect(signal.available).toBe(true);
    expect(signal.value).toBe(0);
    expect(signal.evidence.join(" ")).not.toMatch(/assert nothing/);
  });

  it("recognises assertions destructured from node:assert", async () => {
    // Seen on ai/nanoid: `import { equal } from 'node:assert'` binds a name that
    // matches no known assertion root, so all 52 of its tests reported as
    // "assert nothing at all".
    const signal = await signalFor({
      "test/index.test.js": `import { equal, ok } from 'node:assert';\n\n${repeat(
        (i) => `test('case ${i}', () => {
  equal(compute(${i}), ${i});
  ok(compute(${i}) >= 0);
});`,
      )}`,
    });

    expect(signal.available).toBe(true);
    expect(signal.value).toBe(0);
  });

  it("recognises node:test assert calls", async () => {
    const signal = await signalFor({
      "test.js": repeat(
        (i) => `test('case ${i}', () => {
  assert.strictEqual(compute(${i}), ${i});
});`,
      ),
    });

    expect(signal.available).toBe(true);
    expect(signal.value).toBe(0);
  });

  it("still catches tests that assert only that a mock was called", async () => {
    const signal = await signalFor({
      "src/app.test.ts": repeat(
        (i) => `it('case ${i}', () => {
  const mockFn = vi.fn();
  mockFn();
  expect(mockFn).toHaveBeenCalled();
});`,
      ),
    });

    expect(signal.available).toBe(true);
    expect(signal.value).toBeGreaterThan(0.5);
    expect(signal.evidence.join(" ")).toMatch(/only assert that a mock was called/);
  });

  it("still catches tests with no assertions at all", async () => {
    const signal = await signalFor({
      "src/app.test.ts": repeat(
        (i) => `it('case ${i}', () => {
  const value = compute(${i});
  console.log(value);
});`,
      ),
    });

    expect(signal.available).toBe(true);
    expect(signal.value).toBeGreaterThan(0.5);
    expect(signal.evidence.join(" ")).toMatch(/assert nothing at all/);
  });

  it("reports unavailable rather than clean when a project has no tests", async () => {
    const signal = await signalFor({ "src/index.ts": "export const a = 1;\n" });

    expect(signal.available).toBe(false);
    expect(signal.unavailableReason).toMatch(/no tests/);
  });
});

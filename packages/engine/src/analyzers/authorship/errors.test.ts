import { afterEach, describe, expect, it } from "vitest";

import { buildContext } from "../../scan";
import { createFixtureRepo, type FixtureRepo } from "../../testing/fixture-repo";
import { swallowedErrorFindings, swallowedErrorSignal } from "./errors";

let repo: FixtureRepo | undefined;
afterEach(() => {
  repo?.cleanup();
  repo = undefined;
});

async function signalFor(files: Record<string, string>) {
  repo = createFixtureRepo({ files, withoutGit: true });
  const ctx = await buildContext(repo.rootPath);
  return { signal: swallowedErrorSignal(ctx), ctx };
}

/** `n` handlers of one shape, spread across files so the ratio is per-file too. */
function handlers(body: string, n: number, prefix = "src/mod"): Record<string, string> {
  const files: Record<string, string> = {};
  for (let i = 0; i < n; i++) {
    files[`${prefix}${i}.ts`] = [
      `export function run${i}(): number {`,
      `  try {`,
      `    return risky${i}();`,
      `  } catch (error) {${body}}`,
      `  return 0;`,
      `}`,
      `function risky${i}(): number { return ${i}; }`,
    ].join("\n");
  }
  return files;
}

describe("swallowed errors", () => {
  it("is unavailable when there are too few handlers to judge", async () => {
    const { signal } = await signalFor(handlers("", 2));
    expect(signal.available).toBe(false);
    expect(signal.unavailableReason).toMatch(/too few error handlers/);
    expect(signal.value).toBe(0);
  });

  it("says so plainly when a project has no error handling at all", async () => {
    const { signal } = await signalFor({
      "src/a.ts": "export const a = 1;\n",
      "src/b.ts": "export const b = 2;\n",
    });
    expect(signal.available).toBe(false);
    expect(signal.unavailableReason).toMatch(/no error handlers/);
  });

  it("stays silent when every handler does something with the error", async () => {
    // The case that matters: a codebase handling failures properly must not be
    // flagged for having try/catch in it.
    const { signal } = await signalFor(
      handlers("\n    throw new Error('failed', { cause: error });\n  ", 8),
    );
    expect(signal.available).toBe(true);
    expect(signal.value).toBe(0);
  });

  it("flags handlers that catch and do nothing", async () => {
    const { signal } = await signalFor(handlers("", 8));
    expect(signal.available).toBe(true);
    expect(signal.value).toBe(1);
    expect(signal.evidence[0]).toMatch(/8 of 8 error handlers discard/);
  });

  it("flags handlers that only log", async () => {
    const { signal } = await signalFor(
      handlers("\n    console.error(error);\n  ", 8),
    );
    expect(signal.value).toBe(1);
    expect(signal.evidence.join(" ")).toMatch(/only logs/);
  });

  it("does not flag an empty handler that explains itself", async () => {
    /*
     * `catch { /* the file may not exist * / }` is a decision someone wrote
     * down, which is the opposite of the thing being measured. oxc reports it
     * as zero statements, identical to a bare `catch {}`, so this is only
     * distinguishable via the comment ranges.
     */
    const { signal } = await signalFor(
      handlers("\n    // absent config is expected here\n  ", 8),
    );
    expect(signal.value).toBe(0);
    expect(signal.evidence.join(" ")).toMatch(
      /8 empty handler\(s\) carry an explanatory comment/,
    );
  });

  it("does not flag an empty handler whose binding is underscore-prefixed", async () => {
    /*
     * Seen on `colinhacks/zod`, whose benchmarks time the throwing path with
     * `catch (_err) {}`. 28 of 59 handlers read as discarded and took the repo
     * to 30/100 — the exact figure this project treats as a bug rather than a
     * result. The underscore is a written declaration of intent, the same as a
     * comment, and is ESLint's own default for "intentionally unused".
     */
    const files: Record<string, string> = {};
    for (let i = 0; i < 8; i++) {
      files[`src/bench${i}.ts`] = [
        `export function bench${i}(): void {`,
        `  try {`,
        `    throws${i}();`,
        `  } catch (_err) {}`,
        `}`,
        `function throws${i}(): void { throw new Error("${i}"); }`,
      ].join("\n");
    }

    const { signal } = await signalFor(files);
    expect(signal.value).toBe(0);
  });

  it("still flags a bare binding with no explanation", async () => {
    // The distinction is intent, not syntax: `catch (error) {}` declares nothing.
    const { signal } = await signalFor(handlers("", 8));
    expect(signal.value).toBe(1);
  });

  it("attributes handlers to the files they live in", async () => {
    const { signal } = await signalFor({
      ...handlers("", 5, "src/bad/mod"),
      ...handlers("\n    throw error;\n  ", 5, "src/good/mod"),
    });

    const perFile = signal.perFile ?? {};
    expect(Object.keys(perFile).sort()).toEqual([
      "src/bad/mod0.ts",
      "src/bad/mod1.ts",
      "src/bad/mod2.ts",
      "src/bad/mod3.ts",
      "src/bad/mod4.ts",
    ]);
    expect(perFile["src/bad/mod0.ts"]).toBe(1);
  });

  it("finds Python handlers that pass, and spares the ones that re-raise", async () => {
    const files: Record<string, string> = {};
    for (let i = 0; i < 5; i++) {
      files[`pkg/swallow${i}.py`] = [
        `def run${i}():`,
        `    try:`,
        `        risky()`,
        `    except Exception:`,
        `        pass`,
        "",
      ].join("\n");
      files[`pkg/handled${i}.py`] = [
        `def ok${i}():`,
        `    try:`,
        `        risky()`,
        `    except Exception as exc:`,
        `        raise RuntimeError("failed") from exc`,
        "",
      ].join("\n");
    }

    const { signal } = await signalFor(files);
    expect(signal.available).toBe(true);
    expect(signal.evidence[0]).toMatch(/5 of 10 error handlers discard/);
  });

  it("emits a finding only once discarding is more than incidental", async () => {
    // One swallow among many good handlers is not worth a task in the report.
    const occasional = await signalFor({
      ...handlers("", 1, "src/one/mod"),
      ...handlers("\n    throw error;\n  ", 19, "src/rest/mod"),
    });
    expect(swallowedErrorFindings(occasional.ctx)).toEqual([]);

    const habitual = await signalFor(handlers("", 8));
    const findings = swallowedErrorFindings(habitual.ctx);
    expect(findings).toHaveLength(1);
    expect(findings[0]!.dimension).toBe("health");
    expect(findings[0]!.locations.length).toBeGreaterThan(0);
  });
});

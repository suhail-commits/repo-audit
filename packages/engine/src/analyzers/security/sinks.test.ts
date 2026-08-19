import { afterEach, describe, expect, it } from "vitest";

import { buildContext } from "../../scan";
import { createFixtureRepo, type FixtureRepo } from "../../testing/fixture-repo";
import { dangerousCallFindings, dangerousCallSignal, findSinks } from "./sinks";

let repo: FixtureRepo | undefined;
afterEach(() => {
  repo?.cleanup();
  repo = undefined;
});

async function sinksOf(files: Record<string, string>) {
  repo = createFixtureRepo({ files, withoutGit: true });
  const ctx = await buildContext(repo.rootPath);
  return {
    hits: findSinks(ctx),
    signal: dangerousCallSignal(ctx),
    findings: dangerousCallFindings(ctx),
  };
}

describe("dangerous calls", () => {
  it("flags eval on a runtime value", async () => {
    const { hits, signal } = await sinksOf({
      "src/run.ts": "export function go(input: string) {\n  return eval(input);\n}\n",
    });

    expect(hits.map((h) => h.kind)).toContain("eval");
    expect(signal.value).toBeGreaterThan(0);
  });

  it("flags a shell command built by interpolation", async () => {
    const { hits } = await sinksOf({
      "src/git.ts":
        "import { execSync } from 'node:child_process';\n" +
        "export const show = (ref: string) => execSync(`git show ${ref}`);\n",
    });

    expect(hits.map((h) => h.kind)).toContain("shell-injection");
  });

  /**
   * The single most important case here. A literal command cannot be injected
   * into, and flagging it would fire on essentially every build script in
   * existence.
   */
  it("does not flag a shell command built from a literal", async () => {
    const { hits, signal } = await sinksOf({
      "src/git.ts":
        "import { execSync } from 'node:child_process';\n" +
        "export const head = () => execSync('git rev-parse HEAD');\n" +
        "export const status = () => execSync(`git status --porcelain`);\n",
    });

    expect(hits).toHaveLength(0);
    expect(signal.value).toBe(0);
  });

  it("flags SQL built by concatenation but not a parameterised query", async () => {
    const { hits } = await sinksOf({
      "src/bad.ts":
        "export const find = (db: any, id: string) => db.query('SELECT * FROM t WHERE id = ' + id);\n",
      "src/good.ts":
        "export const findSafe = (db: any, id: string) => db.query('SELECT * FROM t WHERE id = $1', [id]);\n",
    });

    const sql = hits.filter((h) => h.kind === "sql-injection");
    expect(sql).toHaveLength(1);
    expect(sql[0]!.file).toBe("src/bad.ts");
  });

  it("flags wildcard CORS in both spellings", async () => {
    const { hits } = await sinksOf({
      "src/headers.ts":
        "export const headers = { 'Access-Control-Allow-Origin': '*' };\n",
      "src/server.ts":
        "import cors from 'cors';\nexport const mw = cors();\n",
    });

    expect(hits.filter((h) => h.kind === "cors-wildcard")).toHaveLength(2);
  });

  it("does not flag CORS restricted to an origin", async () => {
    const { hits } = await sinksOf({
      "src/server.ts":
        "import cors from 'cors';\nexport const mw = cors({ origin: 'https://app.example.com' });\n",
    });

    expect(hits).toHaveLength(0);
  });

  /**
   * Context, not the call, decides severity. `eval` in a bundler config is a
   * tool doing its job; the same call in a request handler is not.
   */
  it("keeps build tooling out of the score and reports it at low severity", async () => {
    const { signal, findings } = await sinksOf({
      "scripts/build.ts": "export const run = (x: string) => eval(x);\n",
      "src/index.ts": "export const value = 1;\n",
    });

    expect(signal.value).toBe(0);
    expect(signal.evidence.join(" ")).toContain("build scripts");
    expect(findings[0]!.severity).toBe("low");
  });

  it("stays silent on ordinary code", async () => {
    const { hits, signal, findings } = await sinksOf({
      "src/a.ts": "export const add = (a: number, b: number) => a + b;\n",
      "src/b.ts": "export const name = 'demo';\n",
    });

    expect(hits).toHaveLength(0);
    expect(signal.value).toBe(0);
    expect(findings).toHaveLength(0);
  });

  it("reports unavailable rather than clean when there is no JavaScript", async () => {
    const { signal } = await sinksOf({
      "main.py": "def add(a, b):\n    return a + b\n",
    });

    expect(signal.available).toBe(false);
    expect(signal.value).toBe(0);
  });
});

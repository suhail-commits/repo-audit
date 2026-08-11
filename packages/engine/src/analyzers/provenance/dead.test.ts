import { afterEach, describe, expect, it } from "vitest";

import { buildContext } from "../../scan";
import { createFixtureRepo, type FixtureRepo } from "../../testing/fixture-repo";
import { orphanFileSignal, unusedDependencySignal } from "./dead";

let repo: FixtureRepo | undefined;
afterEach(() => {
  repo?.cleanup();
  repo = undefined;
});

async function contextFor(files: Record<string, string>) {
  repo = createFixtureRepo({ files, withoutGit: true });
  return buildContext(repo.rootPath);
}

describe("unused dependencies", () => {
  it("ignores devDependencies, which are CLI tools nothing imports", async () => {
    // chalk, nanoid and zod all tripped this: `rollup`, `size-limit`, `xo`, `c8`
    // are invoked from scripts and config, never imported. Flagging them fired
    // on essentially every real library.
    const ctx = await contextFor({
      "package.json": JSON.stringify({
        name: "lib",
        dependencies: {
          "used-a": "^1.0.0",
          "used-b": "^1.0.0",
          "used-c": "^1.0.0",
          "used-d": "^1.0.0",
          "used-e": "^1.0.0",
        },
        devDependencies: {
          rollup: "^4.0.0",
          "size-limit": "^11.0.0",
          xo: "^0.58.0",
          c8: "^9.0.0",
        },
      }),
      "src/index.ts": [
        `import a from "used-a";`,
        `import b from "used-b";`,
        `import c from "used-c";`,
        `import d from "used-d";`,
        `import e from "used-e";`,
        `export default [a, b, c, d, e];`,
      ].join("\n"),
    });

    const signal = unusedDependencySignal(ctx);
    expect(signal.available).toBe(true);
    expect(signal.value).toBe(0);
    expect(signal.evidence).toEqual([]);
  });

  it("still flags a runtime dependency nothing imports", async () => {
    const ctx = await contextFor({
      "package.json": JSON.stringify({
        name: "lib",
        dependencies: {
          "used-a": "^1.0.0",
          "used-b": "^1.0.0",
          abandoned: "^1.0.0",
          "abandoned-too": "^1.0.0",
          "abandoned-also": "^1.0.0",
        },
      }),
      "src/index.ts": `import a from "used-a";\nimport b from "used-b";\nexport default [a, b];`,
    });

    const signal = unusedDependencySignal(ctx);
    expect(signal.available).toBe(true);
    expect(signal.value).toBeGreaterThan(0);
    expect(signal.evidence.join(" ")).toMatch(/abandoned/);
  });
});

describe("orphan files", () => {
  /** Enough files to clear the signal's minimum sample size. */
  function padding(): Record<string, string> {
    const files: Record<string, string> = {
      "src/index.ts": "",
    };
    const names: string[] = [];
    for (let i = 0; i < 16; i++) {
      names.push(`mod${i}`);
      files[`src/mod${i}.ts`] = `export const value${i} = ${i};\n`;
    }
    files["src/index.ts"] = names
      .map((n, i) => `export { value${i} } from "./${n}.js";`)
      .join("\n");
    return files;
  }

  it("treats standalone runnables and dotfile configs as entry points", async () => {
    // zod's packages/bench/* and nanoid's .prettierrc.js were counted as dead
    // code. You execute a benchmark directly and tooling loads a dotfile config;
    // neither is expected to have importers.
    const ctx = await contextFor({
      ...padding(),
      ".prettierrc.js": `export default { semi: false };\n`,
      "bench/array.ts": `console.log("bench");\n`,
      "examples/basic.ts": `console.log("example");\n`,
      "scripts/release.ts": `console.log("release");\n`,
    });

    const signal = orphanFileSignal(ctx);
    expect(signal.available).toBe(true);
    expect(signal.value).toBe(0);
  });

  it("still flags genuinely unreachable source files", async () => {
    const ctx = await contextFor({
      ...padding(),
      "src/forgotten-a.ts": `export const a = 1;\n`,
      "src/forgotten-b.ts": `export const b = 2;\n`,
      "src/forgotten-c.ts": `export const c = 3;\n`,
      "src/forgotten-d.ts": `export const d = 4;\n`,
    });

    const signal = orphanFileSignal(ctx);
    expect(signal.available).toBe(true);
    expect(signal.value).toBeGreaterThan(0);
    expect(signal.evidence.join(" ")).toMatch(/forgotten/);
  });
});

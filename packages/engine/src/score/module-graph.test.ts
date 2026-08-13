import { describe, expect, it } from "vitest";

import { buildModuleGraph } from "./module-graph";

const files = (spec: Record<string, number>): string[] =>
  Object.entries(spec).flatMap(([dir, n]) =>
    Array.from({ length: n }, (_, i) => `${dir}/f${i}.ts`),
  );

describe("module map", () => {
  it("aggregates file edges to directory edges and counts them", () => {
    const graph = buildModuleGraph({
      files: files({ "apps/web": 4, "packages/engine": 5 }),
      edges: [
        { from: "apps/web/f0.ts", to: "packages/engine/f0.ts" },
        { from: "apps/web/f1.ts", to: "packages/engine/f1.ts" },
        { from: "apps/web/f2.ts", to: "packages/engine/f0.ts" },
      ],
    });

    expect(graph?.edges).toEqual([
      { from: "apps/web", to: "packages/engine", count: 3 },
    ]);
  });

  it("drops self-edges, which every directory has", () => {
    const graph = buildModuleGraph({
      files: files({ "src/a": 3, "src/b": 3 }),
      edges: [
        { from: "src/a/f0.ts", to: "src/a/f1.ts" },
        { from: "src/a/f0.ts", to: "src/b/f0.ts" },
      ],
    });

    expect(graph?.edges).toHaveLength(1);
    expect(graph?.edges[0]).toMatchObject({ from: "src/a", to: "src/b" });
  });

  it("ignores imports that resolved to nothing", () => {
    // An unresolved specifier has no directory to point at, and inventing one
    // would draw a line to a box that does not exist.
    const graph = buildModuleGraph({
      files: files({ "src/a": 3, "src/b": 3 }),
      edges: [
        { from: "src/a/f0.ts", to: null },
        { from: "src/a/f0.ts", to: "src/b/f0.ts" },
      ],
    });

    expect(graph?.edges).toHaveLength(1);
  });

  it("caps the node count and says how many it dropped", () => {
    // A silent cap reads as "this is the whole codebase".
    const spec: Record<string, number> = {};
    for (let i = 0; i < 20; i++) spec[`src/d${i}`] = 20 - i;

    const graph = buildModuleGraph({
      files: files(spec),
      edges: [{ from: "src/d0/f0.ts", to: "src/d1/f0.ts" }],
    });

    expect(graph?.nodes).toHaveLength(12);
    // 19 qualify, not 20: the single-file directory is below `MIN_FILES` and is
    // never a candidate, so it is not "omitted by the cap" either.
    expect(graph?.omitted).toBe(7);
    // Largest first, so the cap keeps the parts of the codebase that matter.
    expect(graph?.nodes[0]?.path).toBe("src/d0");
  });

  it("returns nothing rather than boxes with no lines", () => {
    /*
     * The Python case. `ImportGraph` resolves JS/TS only, so a Python
     * repository produces no edges at all — and a diagram of disconnected
     * boxes is a confident picture of a codebase where nothing imports
     * anything. Same mistake `orphan-files` made scoring that absence as dead
     * code.
     */
    expect(
      buildModuleGraph({ files: files({ "src/a": 5, "src/b": 5 }), edges: [] }),
    ).toBeUndefined();
  });

  it("returns nothing when there is no structure to show", () => {
    expect(
      buildModuleGraph({
        files: files({ "src": 5 }),
        edges: [{ from: "src/f0.ts", to: "src/f1.ts" }],
      }),
    ).toBeUndefined();
  });

  it("returns nothing for an empty repository", () => {
    expect(buildModuleGraph({ files: [], edges: [] })).toBeUndefined();
  });
});

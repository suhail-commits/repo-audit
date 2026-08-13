import { parseSync } from "oxc-parser";
import { describe, expect, it } from "vitest";

/**
 * Pins the parts of oxc's output the engine actually depends on.
 *
 * This exists because of a real failure: between oxc 0.48 and 0.143 the AST
 * renamed `StaticMemberExpression` to the standard ESTree `MemberExpression`.
 * Nothing threw — route extraction just started returning zero results, and the
 * only symptom was tests failing several layers away with "expected [] to equal".
 *
 * oxc ships a new minor roughly weekly and is still pre-1.0, so this will happen
 * again. These assertions turn a silent behaviour change into an obvious failure
 * naming exactly what moved.
 */

describe("oxc parser contract", () => {
  it("emits standard ESTree node type names", () => {
    const { program } = parseSync(
      "a.ts",
      `const x = a.b(1);\nfunction f() {}\nconst g = () => {};\nclass C { m() {} }\ntry { f(); } catch (e) {}`,
    );

    const types = new Set<string>();
    const visit = (node: unknown): void => {
      if (Array.isArray(node)) {
        for (const item of node) visit(item);
        return;
      }
      if (typeof node !== "object" || node === null) return;
      const record = node as Record<string, unknown>;
      if (typeof record["type"] === "string") types.add(record["type"]);
      for (const [key, value] of Object.entries(record)) {
        if (key === "type") continue;
        visit(value);
      }
    };
    visit(program);

    // Every one of these is dispatched on by name somewhere in the analyzers.
    for (const expected of [
      "Program",
      "VariableDeclaration",
      "VariableDeclarator",
      "Identifier",
      "CallExpression",
      "MemberExpression",
      "Literal",
      "FunctionDeclaration",
      "ArrowFunctionExpression",
      "ClassDeclaration",
      // `swallowed-errors` dispatches on this. A rename would make it report
      // zero discarded handlers on every repository — silently clean.
      "TryStatement",
      "CatchClause",
    ]) {
      expect(types, `node type "${expected}" is no longer emitted`).toContain(
        expected,
      );
    }
  });

  it("represents string literals as Literal with a string value", () => {
    const { program } = parseSync("a.js", `app.get('/health', h);`);
    const call = (program as never as Record<string, Record<string, unknown>[]>)[
      "body"
    ]![0]!["expression"] as Record<string, unknown>;
    const args = call["arguments"] as Record<string, unknown>[];

    // Route detection requires a literal path argument to avoid firing on
    // `cache.get(key)`; a node type change here silently disables it.
    expect(args[0]!["type"]).toBe("Literal");
    expect(args[0]!["value"]).toBe("/health");
  });

  it("exposes static imports on the module record", () => {
    const { module } = parseSync("a.ts", `import { db } from "./db.js";`);
    expect(module.staticImports).toHaveLength(1);
    expect(module.staticImports[0]!.moduleRequest.value).toBe("./db.js");
  });

  it("exposes re-export targets on export entries, not on staticImports", () => {
    const { module } = parseSync(
      "index.ts",
      `export * from "./types.js";\nexport { a } from "./other.js";\nexport const local = 1;`,
    );

    // The import graph reads re-export edges from here. When this was missed,
    // every barrel file made its targets look like orphaned dead code.
    const targets = module.staticExports
      .flatMap((record) => record.entries)
      .map((entry) => entry.moduleRequest?.value)
      .filter(Boolean);

    expect(targets).toEqual(["./types.js", "./other.js"]);
    expect(module.staticImports).toHaveLength(0);
  });

  it("exposes export names for locally declared exports", () => {
    const { module } = parseSync("a.ts", `export const GET = 1;`);
    const names = module.staticExports
      .flatMap((record) => record.entries)
      .map((entry) => entry.exportName?.name);
    expect(names).toContain("GET");
  });

  it("reports dynamic imports with a span into the source", () => {
    const source = `const m = await import("./lazy.js");`;
    const { module } = parseSync("a.ts", source);
    expect(module.dynamicImports).toHaveLength(1);
    const span = module.dynamicImports[0]!.moduleRequest;
    expect(source.slice(span.start, span.end)).toBe(`"./lazy.js"`);
  });

  it("returns comments with offsets and stripped delimiters", () => {
    const { comments } = parseSync("a.ts", `// hello\nconst x = 1;`);
    expect(comments).toHaveLength(1);
    expect(comments[0]!.type).toBe("Line");
    expect(comments[0]!.value.trim()).toBe("hello");
    expect(comments[0]!.start).toBe(0);
  });

  it("reports offsets as UTF-16 code units, matching JS string indices", () => {
    // 'é' is 2 bytes in UTF-8 but 1 unit in UTF-16; '😀' is 4 bytes, 2 units.
    // LineMap indexes the source as a JS string, so a switch to byte offsets
    // would silently shift every reported line number on non-ASCII files.
    const source = `const s = "ééé😀";\nconst target = 1;`;
    const { program } = parseSync("a.ts", source);
    const second = (
      program as never as Record<string, Record<string, unknown>[]>
    )["body"]![1]!;

    expect(second["start"]).toBe(source.indexOf("const target"));
  });

  it("returns a program for syntactically broken source instead of throwing", () => {
    // Vibe-coded repos do contain files that do not parse; the scan must survive
    // them rather than aborting the whole run.
    const result = parseSync("a.ts", `function broken( {`);
    expect(result.errors.length).toBeGreaterThan(0);
    expect(result.program).toBeDefined();
  });
});

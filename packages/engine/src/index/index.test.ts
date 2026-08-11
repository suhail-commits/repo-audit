import { afterEach, describe, expect, it } from "vitest";

import { createFixtureRepo, type FixtureRepo } from "../testing/fixture-repo";
import { AstIndex } from "./ast";
import { FileIndex } from "./files";
import { GitIndex } from "./git";
import { ImportGraph } from "./imports";

let repo: FixtureRepo | undefined;
afterEach(() => {
  repo?.cleanup();
  repo = undefined;
});

const TSCONFIG = `{
  // Comments and trailing commas are normal in hand-edited tsconfigs.
  "compilerOptions": {
    "baseUrl": ".",
    "paths": { "@/*": ["src/*"] },
  },
}`;

const ROUTE = `import { db } from '@/lib/db';
import { z } from 'zod';

export async function GET(req: Request) {
  // get the orders
  const rows = await db.query();
  return Response.json(rows);
}
`;

const BASE_FILES = {
  "tsconfig.json": TSCONFIG,
  "package.json": `{"name":"smoke","dependencies":{"zod":"^3.0.0"}}`,
  "src/lib/db.ts": `export const db = { query: async () => [] };\n`,
  "app/api/orders/route.ts": ROUTE,
  "src/orphan.ts": `export function nobodyImportsMe() { return 1 }\n`,
  "node_modules/junk/big.js": "var junk = 1;\n",
  "dist/bundle.js": "var built = 1;\n",
};

describe("FileIndex", () => {
  it("indexes source files and excludes build output", async () => {
    repo = createFixtureRepo({ files: BASE_FILES, withoutGit: true });
    const files = await FileIndex.build(repo.rootPath);
    const paths = files.all().map((f) => f.relPath);

    expect(paths).toContain("app/api/orders/route.ts");
    expect(paths).toContain("src/lib/db.ts");
    expect(paths).toContain("tsconfig.json");
    // node_modules and dist must never reach the index.
    expect(paths.some((p) => p.includes("node_modules"))).toBe(false);
    expect(paths.some((p) => p.startsWith("dist/"))).toBe(false);
  });

  it("counts non-blank lines as sloc", async () => {
    repo = createFixtureRepo({
      files: { "a.ts": "const a = 1;\n\n\nconst b = 2;\n" },
      withoutGit: true,
    });
    const files = await FileIndex.build(repo.rootPath);
    expect(files.get("a.ts")!.sloc).toBe(2);
  });

  it("flags test and generated files so they stay out of authored source", async () => {
    repo = createFixtureRepo({
      files: {
        "src/a.test.ts": "it('x', () => {})\n",
        "src/schema.ts": "// @generated\nexport const x = 1;\n",
        "src/real.ts": "export const y = 2;\n",
      },
      withoutGit: true,
    });
    const files = await FileIndex.build(repo.rootPath);

    expect(files.get("src/a.test.ts")!.isTest).toBe(true);
    expect(files.get("src/schema.ts")!.isGenerated).toBe(true);
    expect(files.sourceFiles().map((f) => f.relPath)).toEqual(["src/real.ts"]);
  });

  it("recognises helpers in a top-level test/ directory as test files", async () => {
    // Seen on ai/nanoid: the directory pattern required a leading separator, so
    // a `test/` folder at the repo root matched nothing and its helper scripts
    // counted as authored source.
    repo = createFixtureRepo({
      files: {
        "test/benchmark.js": "console.log('bench');\n",
        "test/check-versions.js": "console.log('check');\n",
        "index.js": "export default 1;\n",
      },
      withoutGit: true,
    });
    const files = await FileIndex.build(repo.rootPath);

    expect(files.get("test/benchmark.js")!.isTest).toBe(true);
    expect(files.get("test/check-versions.js")!.isTest).toBe(true);
    expect(files.sourceFiles().map((f) => f.relPath)).toEqual(["index.js"]);
  });

  it("recognises a bare test.js at the repo root as a test file", async () => {
    // Seen on sindresorhus/p-limit: the whole suite lives in a root test.js.
    // Missing it counted test code as authored source *and* reported the
    // project as having no tests at the same time.
    repo = createFixtureRepo({
      files: {
        "test.js": "import test from 'ava';\ntest('x', (t) => t.pass());\n",
        "index.js": "export default function limit() {}\n",
      },
      withoutGit: true,
    });
    const files = await FileIndex.build(repo.rootPath);

    expect(files.get("test.js")!.isTest).toBe(true);
    expect(files.sourceFiles().map((f) => f.relPath)).toEqual(["index.js"]);
  });
});

describe("AstIndex", () => {
  it("parses TypeScript and maps offsets to line numbers", async () => {
    repo = createFixtureRepo({ files: BASE_FILES, withoutGit: true });
    const files = await FileIndex.build(repo.rootPath);
    const asts = AstIndex.build(files);

    const route = asts.get("app/api/orders/route.ts")!;
    expect(route.parseErrors).toEqual([]);
    expect(route.comments.map((c) => c.value.trim())).toEqual(["get the orders"]);
    // The comment sits on line 5 of ROUTE.
    expect(route.lineMap.lineAt(route.comments[0]!.start)).toBe(5);
  });

  it("reports line numbers correctly past non-ASCII source", async () => {
    repo = createFixtureRepo({
      files: { "a.ts": `const s = "ééé😀";\n// marker\nconst t = 1;\n` },
      withoutGit: true,
    });
    const files = await FileIndex.build(repo.rootPath);
    const asts = AstIndex.build(files);
    const parsed = asts.get("a.ts")!;
    expect(parsed.lineMap.lineAt(parsed.comments[0]!.start)).toBe(2);
  });
});

describe("ImportGraph", () => {
  it("resolves tsconfig path aliases to repo files", async () => {
    repo = createFixtureRepo({ files: BASE_FILES, withoutGit: true });
    const files = await FileIndex.build(repo.rootPath);
    const graph = ImportGraph.build(files, AstIndex.build(files), repo.rootPath);

    expect(graph.importsOf("app/api/orders/route.ts")).toEqual(["src/lib/db.ts"]);
    expect(graph.importersOf("src/lib/db.ts")).toEqual([
      "app/api/orders/route.ts",
    ]);
  });

  it("separates external packages from unresolved specifiers", async () => {
    repo = createFixtureRepo({
      files: {
        ...BASE_FILES,
        "src/bad.ts": `import x from './does-not-exist';\nexport default x;\n`,
      },
      withoutGit: true,
    });
    const files = await FileIndex.build(repo.rootPath);
    const graph = ImportGraph.build(files, AstIndex.build(files), repo.rootPath);

    expect([...graph.externalPackages]).toContain("zod");
    expect(graph.unresolved).toEqual([
      { from: "src/bad.ts", specifier: "./does-not-exist" },
    ]);
  });

  it("follows re-export edges through barrel files", async () => {
    repo = createFixtureRepo({
      files: {
        "src/types.ts": "export type Thing = { id: string };\n",
        "src/other.ts": "export const a = 1;\nexport const b = 2;\n",
        "src/index.ts": `export * from "./types.js";\nexport { a } from "./other.js";\n`,
      },
      withoutGit: true,
    });
    const files = await FileIndex.build(repo.rootPath);
    const graph = ImportGraph.build(files, AstIndex.build(files), repo.rootPath);

    // These edges exist only on the export records, never in staticImports.
    expect(graph.importsOf("src/index.ts").sort()).toEqual([
      "src/other.ts",
      "src/types.ts",
    ]);
    expect(graph.importersOf("src/types.ts")).toEqual(["src/index.ts"]);
  });

  it("identifies files nothing imports", async () => {
    repo = createFixtureRepo({ files: BASE_FILES, withoutGit: true });
    const files = await FileIndex.build(repo.rootPath);
    const graph = ImportGraph.build(files, AstIndex.build(files), repo.rootPath);

    const roots = graph.roots(files.codeFiles().map((f) => f.relPath));
    expect(roots).toContain("src/orphan.ts");
    expect(roots).not.toContain("src/lib/db.ts");
  });

  it("resolves workspace and relative imports through package exports", async () => {
    repo = createFixtureRepo({
      files: {
        "package.json": `{"name":"root","workspaces":["pkg"]}`,
        "pkg/package.json": `{"name":"@app/lib","main":"./src/entry.ts"}`,
        "pkg/src/entry.ts": `export const helper = 1;\n`,
        // The TypeScript convention of importing a .ts file with a .js suffix.
        "src/consumer.ts": `import { helper } from "../pkg/src/entry.js";\nexport default helper;\n`,
      },
      withoutGit: true,
    });
    const files = await FileIndex.build(repo.rootPath);
    const graph = ImportGraph.build(files, AstIndex.build(files), repo.rootPath);

    expect(graph.importsOf("src/consumer.ts")).toEqual(["pkg/src/entry.ts"]);
  });

  it("honours a nested package's own tsconfig path aliases", async () => {
    // In a monorepo `@/` means something different per package. Resolving every
    // file against the root tsconfig made aliased imports fail, which then made
    // their targets look like unimported dead code.
    repo = createFixtureRepo({
      files: {
        "tsconfig.json": `{"compilerOptions":{"baseUrl":"."}}`,
        "apps/web/tsconfig.json": `{"compilerOptions":{"baseUrl":".","paths":{"@/*":["./src/*"]}}}`,
        "apps/web/src/components/Widget.tsx": `export const Widget = () => null;\n`,
        "apps/web/src/app/page.tsx": `import { Widget } from "@/components/Widget";\nexport default Widget;\n`,
      },
      withoutGit: true,
    });
    const files = await FileIndex.build(repo.rootPath);
    const graph = ImportGraph.build(files, AstIndex.build(files), repo.rootPath);

    expect(graph.importsOf("apps/web/src/app/page.tsx")).toEqual([
      "apps/web/src/components/Widget.tsx",
    ]);
    expect(graph.importersOf("apps/web/src/components/Widget.tsx")).toEqual([
      "apps/web/src/app/page.tsx",
    ]);
  });

  it("still resolves when tsconfig extends a package that is not installed", async () => {
    // We never run `npm install`, so a tsconfig extending a shared config
    // package cannot load its base and oxc-resolver fails EVERY resolution
    // against it. On sindresorhus/ky this produced 0 internal edges from 206
    // imports, making 29 of 30 source files look like dead code.
    repo = createFixtureRepo({
      files: {
        "tsconfig.json": `{"extends":"@some-org/tsconfig","include":["source"]}`,
        "source/index.ts": `import { helper } from "./util.js";\nexport default helper;\n`,
        "source/util.ts": `export const helper = 1;\n`,
      },
      withoutGit: true,
    });
    const files = await FileIndex.build(repo.rootPath);
    const graph = ImportGraph.build(files, AstIndex.build(files), repo.rootPath);

    expect(graph.importsOf("source/index.ts")).toEqual(["source/util.ts"]);
    expect(graph.unresolved).toEqual([]);
  });

  it("counts a workspace package as imported even though it resolves internally", async () => {
    repo = createFixtureRepo({
      files: {
        "package.json": `{"name":"root","dependencies":{"@app/lib":"workspace:*"}}`,
        "node_modules/@app/lib/package.json": `{"name":"@app/lib","main":"./index.js"}`,
        "node_modules/@app/lib/index.js": `export const helper = 1;\n`,
        "src/consumer.ts": `import { helper } from "@app/lib";\nexport default helper;\n`,
      },
      withoutGit: true,
    });
    const files = await FileIndex.build(repo.rootPath);
    const graph = ImportGraph.build(files, AstIndex.build(files), repo.rootPath);

    // Whether it resolves inside or outside the repo, the package was imported —
    // otherwise the unused-dependency check reports every workspace dep as dead.
    expect(graph.importedPackages.has("@app/lib")).toBe(true);
  });
});

describe("GitIndex", () => {
  const COMMITS = [
    {
      message:
        "feat: initial scaffold\n\nCo-Authored-By: Claude <noreply@anthropic.com>",
      files: BASE_FILES,
    },
    { message: "fix", files: { "src/lib/db.ts": "export const db = { q: 1 };\n" } },
    { message: "wip", files: { "src/lib/db.ts": "export const db = { q: 2 };\n" } },
  ];

  it("parses commits, churn, and multi-line bodies", async () => {
    repo = createFixtureRepo({ commits: COMMITS });
    const git = await GitIndex.build(repo.rootPath);

    expect(git.available).toBe(true);
    expect(git.commitCount).toBe(3);

    const first = git.chronological()[0]!;
    expect(first.subject).toBe("feat: initial scaffold");
    expect(first.body).toContain("Co-Authored-By: Claude");
    expect(first.files.length).toBeGreaterThan(0);
    expect(first.churn).toBeGreaterThan(0);
  });

  it("identifies files written once and never revisited", async () => {
    repo = createFixtureRepo({ commits: COMMITS });
    const git = await GitIndex.build(repo.rootPath);

    const writeOnce = git.writeOnceFiles();
    expect(writeOnce).toContain("src/orphan.ts");
    // db.ts was touched in all three commits.
    expect(writeOnce).not.toContain("src/lib/db.ts");
  });

  it("reports unavailable rather than empty when there is no history", async () => {
    repo = createFixtureRepo({ files: BASE_FILES, withoutGit: true });
    const git = await GitIndex.build(repo.rootPath);

    expect(git.available).toBe(false);
    expect(git.unavailableReason).toMatch(/no git history/);
    expect(git.commitCount).toBe(0);
  });
});

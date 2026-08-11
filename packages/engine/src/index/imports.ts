import path from "node:path";

import { ResolverFactory } from "oxc-resolver";

import { normalizePath } from "../ingest/guards";
import type { AstIndex } from "./ast";
import type { FileIndex } from "./files";

export interface ImportEdge {
  from: string;
  /** Repo-relative path when internal, null when the target is a package. */
  to: string | null;
  specifier: string;
  dynamic: boolean;
}

/**
 * Module dependency graph over repo-internal files, plus the set of external
 * packages actually imported.
 *
 * Resolution is delegated to `oxc-resolver` — the same resolver Rolldown uses —
 * rather than hand-rolled path guessing. That matters because import-graph
 * accuracy directly drives the orphan-files signal: a specifier we fail to
 * resolve makes its target look like dead code. The hand-rolled version missed
 * `exports` maps, workspace links, and TypeScript's `.js`-means-`.ts` convention.
 *
 * Edges come from oxc's static module record, so re-exports (`export * from`)
 * are captured alongside plain imports.
 */
export class ImportGraph {
  readonly edges: ImportEdge[] = [];
  /** file → files it imports. */
  private readonly out = new Map<string, Set<string>>();
  /** file → files that import it. */
  private readonly in = new Map<string, Set<string>>();
  /** Bare specifiers that resolved outside the repo, reduced to package names. */
  readonly externalPackages = new Set<string>();
  /**
   * Every package name imported by name, whether it resolved to node_modules or
   * to a linked workspace package inside the repo. Workspace dependencies
   * resolve *internally*, so `externalPackages` alone would report them as
   * declared-but-never-imported.
   */
  readonly importedPackages = new Set<string>();
  /** Specifiers that resolved to nothing in the repo and are not packages. */
  readonly unresolved: { from: string; specifier: string }[] = [];

  static build(files: FileIndex, asts: AstIndex, rootPath: string): ImportGraph {
    const graph = new ImportGraph();
    const resolvers = new ResolverPool(files, rootPath);
    const known = new Set(files.all().map((f) => f.relPath));

    for (const parsed of asts.all()) {
      const file = files.get(parsed.relPath);
      if (!file) continue;
      const fromDir = path.dirname(file.absPath);

      // Path aliases are per-tsconfig, and a monorepo has several.
      const resolver = resolvers.forFile(parsed.relPath);

      for (const { value, dynamic } of specifiersOf(parsed, files)) {
        const target = resolveToRepoFile(
          resolver,
          fromDir,
          value,
          rootPath,
          known,
        );
        graph.add(parsed.relPath, target, value, dynamic);
      }
    }

    return graph;
  }

  private add(
    from: string,
    to: string | null,
    specifier: string,
    dynamic: boolean,
  ): void {
    this.edges.push({ from, to, specifier, dynamic });

    if (isBareSpecifier(specifier)) {
      this.importedPackages.add(packageNameOf(specifier));
    }

    if (to === null) {
      if (isBareSpecifier(specifier)) {
        this.externalPackages.add(packageNameOf(specifier));
      } else {
        this.unresolved.push({ from, specifier });
      }
      return;
    }

    // A module importing itself would make it look reachable; ignore self-edges.
    if (to === from) return;

    if (!this.out.has(from)) this.out.set(from, new Set());
    this.out.get(from)!.add(to);
    if (!this.in.has(to)) this.in.set(to, new Set());
    this.in.get(to)!.add(from);
  }

  importsOf(relPath: string): string[] {
    return [...(this.out.get(relPath) ?? [])];
  }

  importersOf(relPath: string): string[] {
    return [...(this.in.get(relPath) ?? [])];
  }

  /** Files nothing imports — entry points, or orphans. */
  roots(allFiles: string[]): string[] {
    return allFiles.filter((f) => (this.in.get(f)?.size ?? 0) === 0);
  }

  /** Every internal node with at least one edge, for community detection. */
  nodes(): string[] {
    return [...new Set([...this.out.keys(), ...this.in.keys()])];
  }
}

interface Specifier {
  value: string;
  dynamic: boolean;
}

function specifiersOf(
  parsed: ReturnType<AstIndex["all"]>[number],
  files: FileIndex,
): Specifier[] {
  const specifiers: Specifier[] = [];

  for (const imp of parsed.module.staticImports ?? []) {
    const value = imp.moduleRequest?.value;
    if (typeof value === "string") specifiers.push({ value, dynamic: false });
  }

  // Re-exports (`export * from "./x"`) are real edges but live only on the
  // export records, never in staticImports.
  for (const record of parsed.module.staticExports ?? []) {
    for (const entry of record.entries ?? []) {
      const value = entry.moduleRequest?.value;
      if (typeof value === "string") specifiers.push({ value, dynamic: false });
    }
  }

  // Dynamic imports expose only a span, so read the literal from source.
  for (const dyn of parsed.module.dynamicImports ?? []) {
    const value = literalAtSpan(files, parsed.relPath, dyn.moduleRequest);
    if (value) specifiers.push({ value, dynamic: true });
  }

  return specifiers;
}

/**
 * One resolver per tsconfig in the repo, chosen by nearest ancestor.
 *
 * Path aliases are declared per-package: in a monorepo `@/` can mean
 * `apps/web/src` in one directory and something else in another. Resolving every
 * file against the root tsconfig makes aliased imports fail, which then makes
 * their targets look like unimported dead code.
 */
class ResolverPool {
  /** Directory (repo-relative, POSIX) → resolver configured with its tsconfig. */
  private readonly byDir = new Map<string, ResolverFactory>();
  private readonly configDirs: string[];
  private readonly fallback: ResolverFactory;

  constructor(files: FileIndex, rootPath: string) {
    const configs = files
      .all()
      .filter((f) => /(^|\/)(tsconfig|jsconfig)\.json$/.test(f.relPath))
      .map((f) => f.relPath);

    for (const relPath of configs) {
      const dir = relPath.includes("/")
        ? relPath.slice(0, relPath.lastIndexOf("/"))
        : "";
      this.byDir.set(dir, createResolver(path.join(rootPath, relPath)));
    }

    // Deepest first, so `forFile` picks the most specific config.
    this.configDirs = [...this.byDir.keys()].sort(
      (a, b) => b.split("/").length - a.split("/").length || b.length - a.length,
    );
    this.fallback = createResolver(undefined);
  }

  /**
   * Resolvers to try in order for a file: its nearest tsconfig, then a
   * tsconfig-free resolver.
   *
   * The fallback is not a nicety. We never run `npm install`, so a tsconfig that
   * does `"extends": "@sindresorhus/tsconfig"` cannot load its base — and
   * oxc-resolver then fails *every* resolution against that config with
   * "Tsconfig not found". On `sindresorhus/ky` that produced 0 internal edges
   * out of 206 imports, which made 29 of 30 source files look like dead code.
   * Extending a shared config package is common enough that this would have hit
   * a large share of real TypeScript repos.
   */
  forFile(relPath: string): ResolverFactory[] {
    for (const dir of this.configDirs) {
      if (dir === "" || relPath.startsWith(`${dir}/`)) {
        const scoped = this.byDir.get(dir)!;
        return scoped === this.fallback ? [scoped] : [scoped, this.fallback];
      }
    }
    return [this.fallback];
  }
}

function createResolver(tsconfigPath: string | undefined): ResolverFactory {
  return new ResolverFactory({
    extensions: [".ts", ".tsx", ".mts", ".cts", ".js", ".jsx", ".mjs", ".cjs"],
    // TypeScript source imports its own modules with a `.js` suffix that must
    // resolve to the `.ts` file on disk.
    extensionAlias: {
      ".js": [".ts", ".tsx", ".js", ".jsx"],
      ".mjs": [".mts", ".mjs"],
      ".cjs": [".cts", ".cjs"],
    },
    mainFields: ["module", "main"],
    conditionNames: ["import", "node", "default"],
    ...(tsconfigPath
      ? { tsconfig: { configFile: tsconfigPath, references: "auto" as const } }
      : {}),
  });
}

/**
 * Resolve a specifier and keep it only if it lands on a file inside the repo
 * that we actually indexed. Anything else — node_modules, a path outside the
 * root, an unindexed asset — is not an internal edge.
 */
function resolveToRepoFile(
  resolvers: ResolverFactory[],
  fromDir: string,
  specifier: string,
  rootPath: string,
  known: Set<string>,
): string | null {
  const attempts = [{ dir: fromDir, spec: specifier }];

  // Vibe-coded repos frequently use `@/` without declaring it in tsconfig, so
  // fall back to the two layouts Next.js supports. Routed back through the
  // resolver rather than guessed, so extension handling stays consistent.
  const aliasMatch = /^[@~]\/(.*)$/.exec(specifier);
  if (aliasMatch) {
    attempts.push(
      { dir: rootPath, spec: `./src/${aliasMatch[1]}` },
      { dir: rootPath, spec: `./${aliasMatch[1]}` },
    );
  }

  for (const attempt of attempts) {
    for (const resolver of resolvers) {
      let resolved: string | undefined;
      try {
        resolved = resolver.sync(attempt.dir, attempt.spec).path ?? undefined;
      } catch {
        continue;
      }
      if (!resolved) continue;

      const relative = path.relative(rootPath, resolved);
      // Outside the repo (node_modules, or escaped via a symlink) is external.
      if (relative.startsWith("..") || path.isAbsolute(relative)) continue;

      const relPath = normalizePath(relative);
      if (known.has(relPath)) return relPath;
    }
  }

  return null;
}

function isBareSpecifier(spec: string): boolean {
  return (
    !spec.startsWith(".") &&
    !spec.startsWith("/") &&
    !spec.startsWith("@/") &&
    !spec.startsWith("~/")
  );
}

/** "@scope/pkg/sub" → "@scope/pkg"; "lodash/get" → "lodash". */
export function packageNameOf(spec: string): string {
  const parts = spec.split("/");
  if (spec.startsWith("@")) return parts.slice(0, 2).join("/");
  return parts[0] ?? spec;
}

function literalAtSpan(
  files: FileIndex,
  relPath: string,
  span: { start: number; end: number } | undefined,
): string | null {
  if (!span) return null;
  const file = files.get(relPath);
  if (!file) return null;
  const raw = file.content.slice(span.start, span.end);
  const match = /^['"`]([^'"`]*)['"`]$/.exec(raw.trim());
  return match ? match[1]! : null;
}

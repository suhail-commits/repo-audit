import { createRequire } from "node:module";

import TreeSitter from "web-tree-sitter";

import { isStructuralFile } from "../ingest/guards";
import { LineMap } from "./ast";
import type { FileIndex } from "./files";

/**
 * Structural analysis for Python via tree-sitter.
 *
 * This is the second analysis tier. tree-sitter gives a *concrete* syntax tree —
 * every brace and keyword is a node — so it supports structure-shaped signals
 * (duplication, comment narration, assertion counting) but not the semantic ones
 * (import resolution, framework-aware route and auth analysis), which would have
 * to be rebuilt per ecosystem.
 *
 * `web-tree-sitter` is pinned to 0.24.7: 0.26 rejects the prebuilt
 * `tree-sitter-wasms` grammars with an ABI mismatch. WASM also deploys to
 * serverless platforms as a plain asset, where native bindings could not.
 */

// The published typings for 0.24.x do not describe the default-export shape
// this version actually ships, so the surface used here is declared locally.
interface TsNode {
  type: string;
  text: string;
  startIndex: number;
  endIndex: number;
  startPosition: { row: number; column: number };
  isNamed: boolean;
  namedChildCount: number;
  namedChild(index: number): TsNode | null;
  childForFieldName(name: string): TsNode | null;
}

interface TsTree {
  rootNode: TsNode;
  delete?(): void;
}

interface TsParser {
  setLanguage(language: unknown): void;
  parse(source: string): TsTree;
}

interface TsParserCtor {
  new (): TsParser;
  init(): Promise<void>;
  Language: { load(path: string): Promise<unknown> };
}

export interface PythonFile {
  relPath: string;
  tree: TsTree;
  lineMap: LineMap;
}

const require = createRequire(import.meta.url);

/**
 * Locate a grammar without letting a bundler try to inline it.
 *
 * The specifier is assembled at runtime: given a literal, Turbopack treats
 * `require.resolve("….wasm")` as an import and fails the build trying to bundle
 * a binary it has no loader for. The grammar is a runtime asset, kept in the
 * deployment by `outputFileTracingIncludes` in the web app's next.config.
 */
function grammarPath(language: string): string {
  const specifier = ["tree-sitter-wasms", "out", `tree-sitter-${language}.wasm`].join(
    "/",
  );
  return require.resolve(specifier);
}

let parserPromise: Promise<TsParser | null> | undefined;

/**
 * Load the parser and grammar once per process.
 *
 * The grammar path is resolved through `require.resolve` rather than derived
 * from `import.meta.dirname`, which is undefined once this module is bundled.
 */
async function getParser(): Promise<TsParser | null> {
  parserPromise ??= (async () => {
    try {
      const Ctor = ((TreeSitter as unknown as { default?: TsParserCtor })
        .default ?? TreeSitter) as unknown as TsParserCtor;

      await Ctor.init();
      const language = await Ctor.Language.load(grammarPath("python"));

      const parser = new Ctor();
      parser.setLanguage(language);
      return parser;
    } catch {
      // A missing grammar degrades Python to the history tier rather than
      // failing the scan.
      return null;
    }
  })();

  return parserPromise;
}

export class PythonIndex {
  private readonly byPath = new Map<string, PythonFile>();
  readonly warnings: string[] = [];
  /** False when the grammar could not be loaded at all. */
  readonly available: boolean;

  private constructor(available: boolean) {
    this.available = available;
  }

  static async build(files: FileIndex): Promise<PythonIndex> {
    const candidates = files
      .codeFiles()
      .filter((f) => isStructuralFile(f.relPath));

    if (candidates.length === 0) return new PythonIndex(true);

    const parser = await getParser();
    if (!parser) {
      const index = new PythonIndex(false);
      index.warnings.push(
        "Python grammar unavailable; Python files were not analyzed structurally",
      );
      return index;
    }

    const index = new PythonIndex(true);
    let failed = 0;

    for (const file of candidates) {
      try {
        index.byPath.set(file.relPath, {
          relPath: file.relPath,
          tree: parser.parse(file.content),
          lineMap: new LineMap(file.content),
        });
      } catch {
        failed++;
      }
    }

    if (failed > 0) {
      index.warnings.push(`${failed} Python file(s) could not be parsed`);
    }
    return index;
  }

  get(relPath: string): PythonFile | undefined {
    return this.byPath.get(relPath);
  }

  all(): PythonFile[] {
    return [...this.byPath.values()];
  }

  get parsedCount(): number {
    return this.byPath.size;
  }
}

// ---------------------------------------------------------------------------
// Traversal helpers
// ---------------------------------------------------------------------------

/**
 * Walk named nodes only.
 *
 * tree-sitter's concrete tree includes every token — braces, colons, keywords.
 * Anonymous nodes carry no structural meaning for our purposes and roughly
 * double the node count, so they are skipped.
 */
export function walkNamed(
  node: TsNode,
  visit: (node: TsNode) => void | "skip",
): void {
  if (visit(node) === "skip") return;
  for (let i = 0; i < node.namedChildCount; i++) {
    const child = node.namedChild(i);
    if (child) walkNamed(child, visit);
  }
}

export function collectNamed(node: TsNode, types: string | string[]): TsNode[] {
  const wanted = new Set(Array.isArray(types) ? types : [types]);
  const found: TsNode[] = [];
  walkNamed(node, (n) => {
    if (wanted.has(n.type)) found.push(n);
  });
  return found;
}

export type { TsNode, TsTree };

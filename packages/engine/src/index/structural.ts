import { createRequire } from "node:module";

import TreeSitter from "web-tree-sitter";

import { isStructuralFile } from "../ingest/guards";
import { LineMap } from "./ast";
import type { FileIndex } from "./files";
import { languageOf, type Language } from "./language";

/**
 * Structural analysis via tree-sitter, for the languages oxc cannot parse.
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
 *
 * **Adding a language is not just a table entry.** The grammar loading is
 * generic, but every structural signal reads node *names*, which differ per
 * grammar — Python's `except_clause` is Go's `defer_statement` is nothing at
 * all. A language is only listed here once its node names are wired into the
 * signals that claim to support it and a real repository in it has been swept.
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

export interface StructuralFile {
  relPath: string;
  /** Which grammar produced this tree. Signals dispatch on it for node names. */
  language: Language;
  tree: TsTree;
  lineMap: LineMap;
}

/**
 * Language → the grammar filename `tree-sitter-wasms` ships.
 *
 * Only languages actually validated against a real repository appear here.
 * The package ships thirty-odd grammars and all of the obvious ones load under
 * the pinned ABI, but a grammar that loads is not a language that is analysed
 * correctly — see the note above.
 */
const GRAMMARS: Partial<Record<Language, string>> = {
  python: "python",
  go: "go",
  rust: "rust",
};

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

/** One parser per language, built once per process and reused across scans. */
const parsers = new Map<Language, Promise<TsParser | null>>();
let runtimeReady: Promise<TsParserCtor | null> | undefined;

function treeSitterCtor(): TsParserCtor {
  return ((TreeSitter as unknown as { default?: TsParserCtor }).default ??
    TreeSitter) as unknown as TsParserCtor;
}

/**
 * `init()` sets up the shared WASM runtime and must happen once, before any
 * grammar loads. Kept separate from the per-language cache so parsers can be
 * created lazily without each one racing to initialise the runtime.
 */
async function ensureRuntime(): Promise<TsParserCtor | null> {
  runtimeReady ??= (async () => {
    try {
      const Ctor = treeSitterCtor();
      await Ctor.init();
      return Ctor;
    } catch {
      return null;
    }
  })();
  return runtimeReady;
}

/**
 * The parser for one language, or null if its grammar will not load.
 *
 * A missing grammar degrades that language to the history tier rather than
 * failing the scan — and only that language, which is why the cache is keyed
 * per language rather than being a single shared parser.
 */
async function getParser(language: Language): Promise<TsParser | null> {
  const grammar = GRAMMARS[language];
  if (!grammar) return null;

  let cached = parsers.get(language);
  if (!cached) {
    cached = (async () => {
      try {
        const Ctor = await ensureRuntime();
        if (!Ctor) return null;
        const loaded = await Ctor.Language.load(grammarPath(grammar));
        const parser = new Ctor();
        parser.setLanguage(loaded);
        return parser;
      } catch {
        return null;
      }
    })();
    parsers.set(language, cached);
  }

  return cached;
}

export class StructuralIndex {
  private readonly byPath = new Map<string, StructuralFile>();
  readonly warnings: string[] = [];
  /** Languages whose grammar failed to load, so callers can say which. */
  readonly unavailableLanguages: Language[] = [];

  /** True when every language present had a working grammar. */
  get available(): boolean {
    return this.unavailableLanguages.length === 0;
  }

  static async build(files: FileIndex): Promise<StructuralIndex> {
    const index = new StructuralIndex();

    const byLanguage = new Map<Language, typeof candidates>();
    const candidates = files
      .codeFiles()
      .filter((f) => isStructuralFile(f.relPath));

    for (const file of candidates) {
      const language = languageOf(file.relPath);
      const group = byLanguage.get(language) ?? [];
      group.push(file);
      byLanguage.set(language, group);
    }

    // Grammars load concurrently; each is a separate WASM fetch and a repo with
    // both Go and Python should not pay for them in series.
    await Promise.all(
      [...byLanguage].map(async ([language, group]) => {
        const parser = await getParser(language);
        if (!parser) {
          index.unavailableLanguages.push(language);
          index.warnings.push(
            `${language} grammar unavailable; those files were not analyzed structurally`,
          );
          return;
        }

        let failed = 0;
        for (const file of group) {
          try {
            index.byPath.set(file.relPath, {
              relPath: file.relPath,
              language,
              tree: parser.parse(file.content),
              lineMap: new LineMap(file.content),
            });
          } catch {
            failed++;
          }
        }

        if (failed > 0) {
          index.warnings.push(`${failed} ${language} file(s) could not be parsed`);
        }
      }),
    );

    return index;
  }

  get(relPath: string): StructuralFile | undefined {
    return this.byPath.get(relPath);
  }

  all(): StructuralFile[] {
    return [...this.byPath.values()];
  }

  /** Only the files in one language, for signals whose node names differ. */
  inLanguage(language: Language): StructuralFile[] {
    return this.all().filter((f) => f.language === language);
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

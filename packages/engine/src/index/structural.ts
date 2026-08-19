import { existsSync } from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";

import TreeSitter from "web-tree-sitter";

import { isStructuralFile } from "../ingest/guards";
import { LineMap } from "./ast";
import type { FileIndex } from "./files";
import { languageOf, type Language } from "./language";
import { countOf } from "../format";

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
 * Locate a grammar `.wasm`, by whichever route survives the caller's bundler.
 *
 * **Module resolution alone is not enough, and the reason is worth stating.**
 * The specifier used to be assembled at runtime — `["tree-sitter-wasms","out",
 * name].join("/")` — so that Turbopack would not try to bundle a binary it has
 * no loader for. It stopped it bundling, and then Turbopack compiled the
 * `require.resolve` call itself into an unconditional throw:
 *
 *     Language.load(function () {
 *       let e = Error("Cannot find module as expression is too dynamic");
 *       throw (e.code = "MODULE_NOT_FOUND"), e;
 *     }())
 *
 * So in any bundled build the resolve never ran, `getParser` swallowed the
 * error, and every Python, Go and Rust repository silently dropped to the
 * history tier. Found by building the web app for production and scanning
 * `psf/requests`, which reported "python grammar unavailable" — no test failed
 * and nothing threw.
 *
 * The fix is to stop depending on module resolution being present at all: try
 * it, and when it has been compiled away, look for the file on disk instead.
 */
function grammarPath(language: string): string | null {
  const file = `tree-sitter-${language}.wasm`;

  /*
   * First choice, and the only one that is correct by construction: ask the
   * module system. Works under tsx, plain Node and any bundler that left the
   * call intact. Wrapped because a bundler may have replaced it with a throw.
   */
  try {
    const specifier = ["tree-sitter-wasms", "out", file].join("/");
    const resolved = require.resolve(specifier);
    if (existsSync(resolved)) return resolved;
  } catch {
    // Compiled away, or the package is not resolvable from here.
  }

  /*
   * Fallback: walk up from the working directory looking for the package.
   *
   * `process.cwd()` rather than `import.meta.url`, deliberately — a bundler
   * rewrites the module's own location to somewhere inside its output, which
   * is exactly what broke the first approach. The working directory is the one
   * anchor a bundler cannot move.
   */
  for (const dir of ancestors(process.cwd())) {
    const candidate = path.join(dir, "node_modules", "tree-sitter-wasms", "out", file);
    if (existsSync(candidate)) return candidate;
  }

  return null;
}

/** A directory and each of its parents, nearest first. */
function ancestors(from: string): string[] {
  const out: string[] = [];
  let dir = path.resolve(from);
  for (;;) {
    out.push(dir);
    const parent = path.dirname(dir);
    if (parent === dir) return out;
    dir = parent;
  }
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
        const found = grammarPath(grammar);
        if (!found) return null;
        const loaded = await Ctor.Language.load(found);
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
          index.warnings.push(`${countOf(failed, `${language} file`)} could not be parsed`);
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

/** What `probeStructuralParsers` found for one language. */
export interface ParserProbe {
  language: Language;
  /** True only if the grammar loaded *and* parsed a snippet into real nodes. */
  ok: boolean;
  /** Why it failed, when it did. Never swallowed — that is the whole point. */
  reason?: string;
}

/**
 * One snippet per language, chosen to produce named nodes rather than an error
 * node. A grammar that loads but is the wrong ABI still parses, so the probe
 * has to look at what came out.
 */
const PROBE_SOURCE: Record<string, string> = {
  python: "def f(x):\n    return x + 1\n",
  go: "package m\n\nfunc F(x int) int { return x + 1 }\n",
  rust: "fn f(x: i32) -> i32 { x + 1 }\n",
};

/**
 * Check that every grammar this build ships can actually load and parse.
 *
 * Exists because **a missing grammar is silent**. `getParser` returns null and
 * `StructuralIndex` records the language as unavailable — but a grammar is only
 * ever loaded for a language the scanned repository contains, so a build whose
 * `.wasm` assets did not survive packaging looks completely healthy on a
 * JavaScript repository and fails only on someone else's Python one.
 *
 * Deliberately does **not** check that a file exists on disk. That would test
 * the installer rather than the loader, and would pass on an ABI mismatch —
 * which is a real failure mode here, since `web-tree-sitter` is pinned to
 * 0.24.7 precisely because 0.26 rejects these prebuilt grammars.
 *
 * On failure it re-runs the load *outside* the swallowing catch, so the report
 * carries the actual error rather than "it didn't work".
 */
export async function probeStructuralParsers(): Promise<ParserProbe[]> {
  const languages = Object.keys(GRAMMARS) as Language[];

  return Promise.all(
    languages.map(async (language): Promise<ParserProbe> => {
      try {
        const parser = await getParser(language);
        if (!parser) return { language, ok: false, reason: await failureReason(language) };

        const source = PROBE_SOURCE[language] ?? "";
        const tree = parser.parse(source);
        if (tree.rootNode.namedChildCount === 0) {
          return {
            language,
            ok: false,
            reason: "grammar loaded but parsed no named nodes",
          };
        }
        return { language, ok: true };
      } catch (err) {
        return { language, ok: false, reason: String(err).slice(0, 200) };
      }
    }),
  );
}

/** Re-attempt the load without the catch, to recover the real error. */
async function failureReason(language: Language): Promise<string> {
  const grammar = GRAMMARS[language];
  if (!grammar) return "no grammar registered for this language";
  try {
    const Ctor = treeSitterCtor();
    await Ctor.init();
    const found = grammarPath(grammar);
    if (!found) {
      return `grammar file not found: tree-sitter-${grammar}.wasm is not installed anywhere above ${process.cwd()}`;
    }
    await Ctor.Language.load(found);
    return "grammar loaded on retry — the parser cache holds an earlier failure";
  } catch (err) {
    return String(err).slice(0, 200);
  }
}

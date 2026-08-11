import { parseSync } from "oxc-parser";

import { isJsTsFile } from "../ingest/guards";

import type { FileIndex, IndexedFile } from "./files";

/** Minimal structural shape shared by every ESTree node oxc emits. */
export interface AstNode {
  type: string;
  start: number;
  end: number;
  [key: string]: unknown;
}

export interface Comment {
  type: "Line" | "Block";
  value: string;
  start: number;
  end: number;
}

/** oxc's static module record — reliable import/export data without walking. */
export interface ModuleRecord {
  hasModuleSyntax: boolean;
  staticImports: {
    moduleRequest: { value: string; start: number; end: number };
    entries: unknown[];
  }[];
  /**
   * Export records. Note that re-export targets (`export * from "./x"`) appear
   * here on the entry's `moduleRequest` and NOT in `staticImports` — a module
   * graph built from staticImports alone silently misses every barrel file.
   */
  staticExports: {
    entries: {
      moduleRequest?: { value: string; start: number; end: number };
      importName?: { kind?: string; name?: string };
      exportName?: { name?: string };
    }[];
  }[];
  dynamicImports: { moduleRequest: { start: number; end: number } }[];
}

export interface ParsedFile {
  relPath: string;
  program: AstNode;
  comments: Comment[];
  module: ModuleRecord;
  lineMap: LineMap;
  /** Syntax errors. A file with errors is still partially usable. */
  parseErrors: string[];
}

/**
 * Source-offset → 1-indexed line lookup.
 *
 * oxc reports positions as UTF-16 code-unit offsets, matching plain JS string
 * indices (verified against non-ASCII and astral-plane source). Built once per
 * file, binary-searched thereafter.
 */
export class LineMap {
  /** Byte offset at which each line starts. */
  private readonly starts: number[];

  constructor(source: string) {
    const starts = [0];
    for (let i = 0; i < source.length; i++) {
      if (source.charCodeAt(i) === 10) starts.push(i + 1);
    }
    this.starts = starts;
  }

  lineAt(offset: number): number {
    let lo = 0;
    let hi = this.starts.length - 1;
    while (lo < hi) {
      const mid = (lo + hi + 1) >> 1;
      if (this.starts[mid]! <= offset) lo = mid;
      else hi = mid - 1;
    }
    return lo + 1;
  }

  get lineCount(): number {
    return this.starts.length;
  }
}

/**
 * Every JS/TS file parsed exactly once.
 *
 * The parser is deliberately hidden behind ParsedFile so a different backend
 * (tree-sitter for other languages) can be added without touching analyzers.
 */
export class AstIndex {
  private readonly byPath = new Map<string, ParsedFile>();
  readonly warnings: string[] = [];

  private constructor() {}

  static build(files: FileIndex): AstIndex {
    const index = new AstIndex();
    let failed = 0;

    // oxc parses JavaScript and TypeScript only. Other languages are indexed as
    // source (so they count towards the language profile) but parsed elsewhere,
    // or not at all.
    for (const file of files.codeFiles().filter((f) => isJsTsFile(f.relPath))) {
      const parsed = parseFile(file);
      if (parsed) index.byPath.set(file.relPath, parsed);
      else failed++;
    }

    if (failed > 0) {
      index.warnings.push(`${failed} file(s) could not be parsed`);
    }
    return index;
  }

  get(relPath: string): ParsedFile | undefined {
    return this.byPath.get(relPath);
  }

  all(): ParsedFile[] {
    return [...this.byPath.values()];
  }

  get parsedCount(): number {
    return this.byPath.size;
  }
}

function parseFile(file: IndexedFile): ParsedFile | null {
  try {
    const result = parseSync(file.relPath, file.content);
    return {
      relPath: file.relPath,
      program: result.program as unknown as AstNode,
      comments: result.comments as unknown as Comment[],
      module: result.module as unknown as ModuleRecord,
      lineMap: new LineMap(file.content),
      parseErrors: result.errors.map((e) => e.message),
    };
  } catch {
    return null;
  }
}

/** Keys on an AST node that are never child nodes. */
const NON_CHILD_KEYS = new Set(["type", "start", "end", "range", "loc", "parent"]);

export interface WalkVisitor {
  enter?(node: AstNode, ancestors: readonly AstNode[]): void | "skip";
  leave?(node: AstNode, ancestors: readonly AstNode[]): void;
}

/**
 * Depth-first walk over an ESTree tree.
 *
 * Returning "skip" from `enter` prunes the subtree — used by rules that stop at
 * nested function boundaries (an auth check inside a nested callback does not
 * protect the outer handler).
 */
export function walk(root: AstNode, visitor: WalkVisitor): void {
  const ancestors: AstNode[] = [];

  function visit(node: AstNode): void {
    const action = visitor.enter?.(node, ancestors);
    if (action !== "skip") {
      ancestors.push(node);
      for (const key of Object.keys(node)) {
        if (NON_CHILD_KEYS.has(key)) continue;
        const value = node[key];
        if (Array.isArray(value)) {
          for (const item of value) {
            if (isNode(item)) visit(item);
          }
        } else if (isNode(value)) {
          visit(value);
        }
      }
      ancestors.pop();
    }
    visitor.leave?.(node, ancestors);
  }

  visit(root);
}

export function isNode(value: unknown): value is AstNode {
  return (
    typeof value === "object" &&
    value !== null &&
    typeof (value as { type?: unknown }).type === "string"
  );
}

/** Collect every node of the given types. Convenience over `walk`. */
export function collect(root: AstNode, types: string | string[]): AstNode[] {
  const wanted = new Set(Array.isArray(types) ? types : [types]);
  const found: AstNode[] = [];
  walk(root, {
    enter(node) {
      if (wanted.has(node.type)) found.push(node);
    },
  });
  return found;
}

/**
 * Flatten a member expression to dotted source form: `supabase.from` from
 * `supabase.from(...)`'s callee. Returns null for computed or dynamic access.
 */
export function memberPath(node: AstNode | undefined): string | null {
  if (!node) return null;
  if (node.type === "Identifier") return String(node["name"]);
  if (node.type === "ThisExpression") return "this";
  if (node.type === "MemberExpression") {
    if (node["computed"] === true) return null;
    const object = memberPath(node["object"] as AstNode | undefined);
    const property = node["property"] as AstNode | undefined;
    if (!object || !property || property.type !== "Identifier") return null;
    return `${object}.${String(property["name"])}`;
  }
  return null;
}

export const FUNCTION_NODE_TYPES = new Set([
  "FunctionDeclaration",
  "FunctionExpression",
  "ArrowFunctionExpression",
]);

export function isFunctionNode(node: AstNode): boolean {
  return FUNCTION_NODE_TYPES.has(node.type);
}

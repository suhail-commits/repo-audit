import { createHash } from "node:crypto";

import type { Finding, Signal } from "@vibe/shared";

import { isFunctionNode, walk, type AstNode, type ParsedFile } from "../../index/ast";
import type { Language } from "../../index/language";
import {
  collectNamed,
  walkNamed,
  type StructuralFile,
  type TsNode,
} from "../../index/structural";
import { ramp, type AnalysisContext } from "../context";

/**
 * Type-2 clone detection: structurally identical functions that differ only in
 * identifiers and literal values.
 *
 * This is the signal that survives a zip upload with no git history. It catches
 * the characteristic agent failure of re-writing a helper it already wrote,
 * because it has no memory of the earlier one — three slightly different
 * `formatDate` functions in three files.
 */

export const WEIGHT = 2.5;

/**
 * Functions smaller than this match by coincidence and are ignored.
 *
 * **Raised from 18 after reading the report this tool produces about itself.**
 * At 18, every one of the eight Code health findings on this repository was a
 * pair of one-line helpers: `isTestFile` and `isGeneratedPath`
 * (`return PATTERNS.some((p) => p.test(relPath))`), `importsOf` and
 * `importersOf`, `authorshipBand` and `healthBand`. Each really is the same
 * shape, and saying so is useless — two guard clauses that both delegate to
 * `.some()` are not a duplication problem, they are what a small function looks
 * like.
 *
 * A TypeScript one-liner reaches about 19 named nodes once its parameter types,
 * return type and the arrow inside it are counted, which is why 18 caught them
 * and why the figure has to clear that band rather than sit against it. 30 also
 * matches what Go and Rust already use for the same reason — the threshold is
 * about how many nodes a language spends before saying anything, and annotated
 * TypeScript spends about as many as Go does.
 *
 * The cost is real and accepted: a genuinely duplicated short helper is now
 * missed. **A false positive costs more than a missed finding**, and eight
 * trivial ones at the top of a section is how a reader decides the tool is
 * naive.
 */
const MIN_NODES = 30;

/**
 * Per-language node names, because "identifier" and "a function" are spelled
 * differently in every grammar.
 *
 * `functions` are the nodes worth hashing. `identifiers` and `literals` are
 * erased to `$` and `#`, which is what makes this type-2 detection: two
 * functions with the same shape and different names collide.
 *
 * `minNodes` is a *per-language* threshold counted over named nodes only, and
 * it is not transferable. Python is terse, so 18 nodes is already real logic.
 * Go and Rust spell out types as nodes — a one-line Go function that does
 * nothing interesting already measures around 18 — so the same figure there
 * would match trivial accessors by coincidence.
 */
interface GrammarShape {
  functions: string[];
  identifiers: Set<string>;
  literals: Set<string>;
  minNodes: number;
  /** Field holding the function's name, for the report. */
  nameField: string;
}

const GRAMMAR_SHAPES: Partial<Record<Language, GrammarShape>> = {
  python: {
    functions: ["function_definition"],
    identifiers: new Set(["identifier", "dotted_name"]),
    literals: new Set([
      "string",
      "string_content",
      "integer",
      "float",
      "true",
      "false",
      "none",
    ]),
    minNodes: 18,
    nameField: "name",
  },
  go: {
    functions: ["function_declaration", "method_declaration", "func_literal"],
    identifiers: new Set([
      "identifier",
      "type_identifier",
      "field_identifier",
      "package_identifier",
    ]),
    literals: new Set([
      "int_literal",
      "float_literal",
      "imaginary_literal",
      "rune_literal",
      "interpreted_string_literal",
      "raw_string_literal",
      "true",
      "false",
      "nil",
    ]),
    minNodes: 30,
    nameField: "name",
  },
  rust: {
    functions: ["function_item", "closure_expression"],
    identifiers: new Set([
      "identifier",
      "type_identifier",
      "field_identifier",
      "scoped_identifier",
      "primitive_type",
    ]),
    literals: new Set([
      "integer_literal",
      "float_literal",
      "string_literal",
      "raw_string_literal",
      "char_literal",
      "boolean_literal",
    ]),
    minNodes: 30,
    nameField: "name",
  },
};

export interface FunctionShape {
  file: string;
  line: number;
  name: string;
  nodeCount: number;
  /** Hash of the structure with identifiers and literals erased. */
  shapeHash: string;
}

export interface CloneFamily {
  shapeHash: string;
  members: FunctionShape[];
  nodeCount: number;
}

export interface CloneReport {
  families: CloneFamily[];
  totalFunctions: number;
  clonedFunctions: number;
}

/**
 * Reduce a function to a structural fingerprint.
 *
 * Only node types are kept, so `formatDate(d)` and `prettyDate(when)` with the
 * same body shape collapse to the same hash. Literal values are erased for the
 * same reason.
 */
function shapeOf(fn: AstNode): { hash: string; nodeCount: number } {
  const tokens: string[] = [];
  let nodeCount = 0;

  walk(fn, {
    enter(node) {
      nodeCount++;
      switch (node.type) {
        case "Identifier":
        case "PrivateIdentifier":
          tokens.push("$");
          break;
        case "Literal":
        case "TemplateElement":
          tokens.push("#");
          break;
        default:
          tokens.push(node.type);
      }
    },
  });

  return {
    hash: createHash("sha1").update(tokens.join(",")).digest("hex"),
    nodeCount,
  };
}

/** Best-effort name for a function, from its declaration or binding. */
function nameOf(fn: AstNode, ancestors: readonly AstNode[]): string {
  const id = fn["id"] as AstNode | undefined;
  if (id?.type === "Identifier") return String(id["name"]);

  const parent = ancestors[ancestors.length - 1];
  if (parent?.type === "VariableDeclarator") {
    const target = parent["id"] as AstNode | undefined;
    if (target?.type === "Identifier") return String(target["name"]);
  }
  if (parent?.type === "Property" || parent?.type === "MethodDefinition") {
    const key = parent["key"] as AstNode | undefined;
    if (key?.type === "Identifier") return String(key["name"]);
  }
  return "<anonymous>";
}

export function collectFunctionShapes(parsed: ParsedFile): FunctionShape[] {
  const shapes: FunctionShape[] = [];

  walk(parsed.program, {
    enter(node, ancestors) {
      if (!isFunctionNode(node)) return;
      const { hash, nodeCount } = shapeOf(node);
      if (nodeCount < MIN_NODES) return;
      shapes.push({
        file: parsed.relPath,
        line: parsed.lineMap.lineAt(node.start),
        name: nameOf(node, ancestors),
        nodeCount,
        shapeHash: hash,
      });
    },
  });

  return shapes;
}

/**
 * The tree-sitter equivalent, over any grammar with a shape table.
 *
 * Same idea as the JS/TS version — hash the structure with names and literals
 * erased — with two adjustments for a concrete tree. Only *named* nodes are
 * counted, since the CST includes every colon and keyword; and the node
 * threshold comes from the language, because verbosity per unit of logic is
 * not the same in Python and Go.
 *
 * Returns nothing for a language with no table. That is the honest answer: a
 * grammar we can load but whose node names we have not wired up would produce
 * shapes made entirely of unrecognised types, which hash consistently and would
 * therefore report confident, meaningless duplication.
 */
export function collectStructuralFunctionShapes(
  parsed: StructuralFile,
): FunctionShape[] {
  const grammar = GRAMMAR_SHAPES[parsed.language];
  if (!grammar) return [];

  const shapes: FunctionShape[] = [];
  const excluded = inlineTestRanges(parsed);

  for (const fn of collectNamed(parsed.tree.rootNode, grammar.functions)) {
    if (excluded.some(([from, to]) => fn.startIndex >= from && fn.endIndex <= to)) {
      continue;
    }

    const tokens: string[] = [];
    let nodeCount = 0;

    walkNamed(fn, (node) => {
      nodeCount++;
      if (grammar.identifiers.has(node.type)) tokens.push("$");
      else if (grammar.literals.has(node.type)) tokens.push("#");
      else tokens.push(node.type);
    });

    if (nodeCount < grammar.minNodes) continue;

    shapes.push({
      file: parsed.relPath,
      line: fn.startPosition.row + 1,
      name: fn.childForFieldName(grammar.nameField)?.text ?? "<anonymous>",
      nodeCount,
      shapeHash: createHash("sha1").update(tokens.join(",")).digest("hex"),
    });
  }

  return shapes;
}

/** Rust attributes that mark the item after them as test-only. */
const RUST_TEST_ATTRIBUTE = /^#\s*\[\s*(cfg\s*\(\s*test\s*\)|test\b|bench\b|\w+::test\b)/;

/**
 * Source ranges holding tests that live *inside* a source file.
 *
 * Path-based test detection cannot see these. Rust's dominant convention is a
 * `#[cfg(test)] mod tests` block at the bottom of the module it tests, so on
 * `BurntSushi/ripgrep` every clone family was inline test code in genuine
 * source files — `crates/core/flags/defs.rs` and `crates/printer/src/standard.rs`
 * — and `duplicate-logic` read 0.57 on a repository whose tests are simply
 * table-shaped, as test tables are.
 *
 * Attributes are siblings of the item they annotate rather than children, which
 * is why this walks ordered children instead of using `collectNamed`.
 */
function inlineTestRanges(parsed: StructuralFile): Array<[number, number]> {
  if (parsed.language !== "rust") return [];

  const ranges: Array<[number, number]> = [];

  const visit = (node: TsNode): void => {
    let previous: TsNode | null = null;
    for (let i = 0; i < node.namedChildCount; i++) {
      const child = node.namedChild(i);
      if (!child) continue;

      if (
        previous?.type === "attribute_item" &&
        RUST_TEST_ATTRIBUTE.test(previous.text)
      ) {
        // The whole annotated item goes, so a `#[cfg(test)] mod` takes every
        // function inside it without needing to recurse.
        ranges.push([child.startIndex, child.endIndex]);
      } else {
        visit(child);
      }

      previous = child;
    }
  };

  visit(parsed.tree.rootNode);
  return ranges;
}

export function analyzeClones(ctx: AnalysisContext): CloneReport {
  const byHash = new Map<string, FunctionShape[]>();
  let totalFunctions = 0;

  const add = (shapes: FunctionShape[]): void => {
    for (const shape of shapes) {
      totalFunctions++;
      const bucket = byHash.get(shape.shapeHash);
      if (bucket) bucket.push(shape);
      else byHash.set(shape.shapeHash, [shape]);
    }
  };

  // Generated code and tests duplicate legitimately; judge authored source only.
  const isAuthored = (relPath: string): boolean => {
    const file = ctx.files.get(relPath);
    return !!file && !file.isGenerated && !file.isTest;
  };

  for (const parsed of ctx.asts.all()) {
    if (isAuthored(parsed.relPath)) add(collectFunctionShapes(parsed));
  }

  /*
   * Hashes are over node-type token sequences and the grammars use disjoint
   * type names, so a Python function cannot collide with a Go or a JS one.
   * That matters: a cross-language "duplicate" would be nonsense.
   */
  for (const parsed of ctx.structural.all()) {
    if (isAuthored(parsed.relPath)) add(collectStructuralFunctionShapes(parsed));
  }

  const families: CloneFamily[] = [];
  let clonedFunctions = 0;

  for (const [shapeHash, members] of byHash) {
    if (members.length < 2) continue;
    clonedFunctions += members.length;
    families.push({
      shapeHash,
      members,
      nodeCount: members[0]!.nodeCount,
    });
  }

  // Biggest, most duplicated families first — those are what the report shows.
  families.sort(
    (a, b) =>
      b.members.length * b.nodeCount - a.members.length * a.nodeCount,
  );

  return { families, totalFunctions, clonedFunctions };
}

export function cloneSignal(ctx: AnalysisContext, report: CloneReport): Signal {
  if (report.totalFunctions < 20) {
    return {
      id: "duplicate-logic",
      value: 0,
      weight: WEIGHT,
      available: false,
      evidence: [],
      unavailableReason: "too few functions to measure duplication",
    };
  }

  const ratio = report.clonedFunctions / report.totalFunctions;
  const evidence: string[] = [
    `${report.clonedFunctions} of ${report.totalFunctions} functions (${Math.round(ratio * 100)}%) are structural duplicates of another function`,
  ];

  const worst = report.families[0];
  if (worst) {
    const names = [...new Set(worst.members.map((m) => m.name))].slice(0, 4);
    evidence.push(
      `Largest duplicate group: ${worst.members.length} copies (${names.join(", ")})`,
    );
  }

  /*
   * Per file: how much of that file's duplicated weight sits here. A file with
   * three cloned functions is more implicated than one with a single copy, so
   * this counts members rather than marking files present-or-absent.
   */
  const clonedPerFile = new Map<string, number>();
  for (const family of report.families) {
    if (family.members.length < 2) continue;
    for (const member of family.members) {
      clonedPerFile.set(member.file, (clonedPerFile.get(member.file) ?? 0) + 1);
    }
  }

  const perFile: Record<string, number> = {};
  for (const [file, count] of clonedPerFile) {
    // Three or more clones in one file is as strong as this gets; past that the
    // value would keep climbing on a distinction nobody acts on differently.
    perFile[file] = Math.min(1, count / 3);
  }

  return {
    id: "duplicate-logic",
    value: ramp(ratio, 0.05, 0.35),
    weight: WEIGHT,
    available: true,
    evidence,
    perFile,
  };
}

/** One finding per significant clone family, capped so reports stay readable. */
export function cloneFindings(report: CloneReport, limit = 10): Finding[] {
  return report.families
    .filter((f) => f.members.length >= 2 && f.nodeCount >= MIN_NODES)
    .slice(0, limit)
    .map((family) => {
      const names = [...new Set(family.members.map((m) => m.name))];
      return {
        ruleId: "duplicate-function",
        dimension: "health" as const,
        severity: family.members.length >= 4 ? ("medium" as const) : ("low" as const),
        confidence: "high" as const,
        source: "builtin" as const,
        title: `${family.members.length} structurally identical copies of the same function`,
        locations: family.members.map((m) => ({ file: m.file, line: m.line })),
        data: {
          copies: family.members.length,
          names,
          files: [...new Set(family.members.map((m) => m.file))],
        },
        estimatedFixMinutes: 15 * (family.members.length - 1),
      };
    });
}

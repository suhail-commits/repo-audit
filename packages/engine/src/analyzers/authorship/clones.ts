import { createHash } from "node:crypto";

import type { Finding, Signal } from "@vibe/shared";

import { isFunctionNode, walk, type AstNode, type ParsedFile } from "../../index/ast";
import {
  collectNamed,
  walkNamed,
  type PythonFile,
} from "../../index/python";
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

/** Functions smaller than this match by coincidence and are ignored. */
const MIN_NODES = 18;

/**
 * Python threshold, counted over *named* CST nodes only.
 *
 * Measured against real functions: a two-line `def add(a, b)` is 10 nodes, a
 * five-line loop is 19, a six-line date helper is 45. Eighteen therefore keeps
 * anything with real logic and drops trivial accessors — landing in the same
 * place as the JS/TS figure rather than above it, because filtering out
 * anonymous nodes already removes the CST's extra punctuation.
 */
const MIN_PYTHON_NODES = 18;

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
 * Python equivalent, over tree-sitter's concrete tree.
 *
 * Same idea as the JS/TS version — hash the shape with names and literals erased
 * — with two adjustments for the different tree. Only *named* nodes are counted,
 * since the CST includes every colon and keyword; and the node threshold is
 * higher because Python bodies are terser, so a low threshold matches trivial
 * functions by coincidence.
 */
export function collectPythonFunctionShapes(parsed: PythonFile): FunctionShape[] {
  const shapes: FunctionShape[] = [];

  for (const fn of collectNamed(parsed.tree.rootNode, "function_definition")) {
    const tokens: string[] = [];
    let nodeCount = 0;

    walkNamed(fn, (node) => {
      nodeCount++;
      switch (node.type) {
        case "identifier":
        case "dotted_name":
          tokens.push("$");
          break;
        case "string":
        case "string_content":
        case "integer":
        case "float":
        case "true":
        case "false":
        case "none":
          tokens.push("#");
          break;
        default:
          tokens.push(node.type);
      }
    });

    if (nodeCount < MIN_PYTHON_NODES) continue;

    shapes.push({
      file: parsed.relPath,
      line: fn.startPosition.row + 1,
      name: fn.childForFieldName("name")?.text ?? "<anonymous>",
      nodeCount,
      shapeHash: createHash("sha1").update(tokens.join(",")).digest("hex"),
    });
  }

  return shapes;
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

  // Hashes are of node-type token sequences, and the two parsers use disjoint
  // type names, so a Python function can never collide with a JS one.
  for (const parsed of ctx.python.all()) {
    if (isAuthored(parsed.relPath)) add(collectPythonFunctionShapes(parsed));
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

  return {
    id: "duplicate-logic",
    value: ramp(ratio, 0.05, 0.35),
    weight: WEIGHT,
    available: true,
    evidence,
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

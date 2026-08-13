import type { Finding, Signal } from "@vibe/shared";

import {
  collect,
  memberPath,
  type AstNode,
  type Comment,
  type ParsedFile,
} from "../../index/ast";
import { collectNamed, type StructuralFile, type TsNode } from "../../index/structural";
import { ramp, unavailable, type AnalysisContext } from "../context";
import { countOf } from "../../format";

/**
 * Error handlers that catch a failure and then discard it.
 *
 * Two shapes, both provable from syntax alone:
 *
 * - **empty** — `catch {}` / `except: pass`. The failure is caught so it cannot
 *   propagate, and then nothing happens.
 * - **log-only** — the handler prints the error and does nothing else. In
 *   production nobody reads that line, and the caller is told the operation
 *   succeeded.
 *
 * This is a defect and a tell at once, which is why it feeds both dimensions.
 * Generated code reaches for `try`/`catch` to make an error go away rather than
 * to recover from it, because the model is optimising for code that does not
 * throw during review rather than for code that behaves when the call fails.
 *
 * **Two forms of written intent are not counted**, because both say the author
 * considered the failure and chose to drop it, which is the opposite of the
 * thing being measured:
 *
 * - a comment inside the handler. oxc reports `catch { /* expected * / }` as
 *   zero statements, identical to a bare `catch {}`, so telling them apart
 *   needs the comment ranges rather than the statement count.
 * - an underscore-prefixed binding — `catch (_err) {}`. The convention is
 *   near-universal and is ESLint's own default for "intentionally unused".
 *   Seen on `colinhacks/zod`, whose benchmarks time the throwing path with
 *   `catch (_err) {}`: 28 of 59 handlers read as discarded and pushed the
 *   repository to 30/100, the exact figure this project treats as a bug.
 *
 * Floating promises were considered and left out. Knowing that a call returns a
 * promise needs type information we do not have, so detection would come down
 * to guessing from names — the false-positive machine this project exists to
 * avoid.
 */

export const WEIGHT = 1.5;

/** Below this the ratio is one or two handlers deciding the whole signal. */
const MIN_HANDLERS = 5;

/** Call targets that record an error without doing anything about it. */
const LOG_ROOTS = new Set(["console", "logger", "log", "winston", "pino"]);
const PYTHON_LOG_CALLS = /^(print|logging\.\w+|logger\.\w+|log\.\w+)$/;

interface HandlerTally {
  total: number;
  /** Empty, or log-and-continue. */
  discarded: number;
  /** Empty but carrying an explanation. Counted as handled, not discarded. */
  documented: number;
  byFile: Map<string, { total: number; discarded: number }>;
  examples: { file: string; line: number; kind: "empty" | "log-only" }[];
}

export function swallowedErrorSignal(ctx: AnalysisContext): Signal {
  const id = "swallowed-errors";
  const tally = tallyHandlers(ctx);

  if (tally.total < MIN_HANDLERS) {
    return unavailable(
      id,
      WEIGHT,
      tally.total === 0
        ? "no error handlers found to judge"
        : "too few error handlers to judge",
    );
  }

  const ratio = tally.discarded / tally.total;

  const evidence: string[] = [];
  if (tally.discarded > 0) {
    evidence.push(
      `${tally.discarded} of ${tally.total} error handlers discard the error or only log it`,
    );
    for (const ex of tally.examples.slice(0, 3)) {
      evidence.push(
        `${ex.file}:${ex.line} — ${ex.kind === "empty" ? "catches and does nothing" : "catches and only logs"}`,
      );
    }
  }
  if (tally.documented > 0) {
    // Say this out loud: it is the difference between a codebase that ignores
    // failures and one that decided to, and the reader should know we can tell.
    evidence.push(
      `${countOf(tally.documented, "empty handler")} carry an explanatory comment and were not counted`,
    );
  }

  const perFile: Record<string, number> = {};
  for (const [file, counts] of tally.byFile) {
    if (counts.discarded > 0) perFile[file] = counts.discarded / counts.total;
  }

  return {
    id,
    // Every codebase has one or two. A third of them is a habit.
    value: ramp(ratio, 0.15, 0.6),
    weight: WEIGHT,
    available: true,
    evidence,
    perFile,
  };
}

/** One finding, listing where the discarded failures are. */
export function swallowedErrorFindings(ctx: AnalysisContext): Finding[] {
  const tally = tallyHandlers(ctx);
  if (tally.total < MIN_HANDLERS || tally.discarded === 0) return [];
  if (tally.discarded / tally.total < 0.15) return [];

  return [
    {
      ruleId: "swallowed-errors",
      dimension: "health",
      severity: tally.discarded >= 10 ? "medium" : "low",
      confidence: "high",
      source: "builtin",
      title: `${tally.discarded} error handlers discard the error`,
      locations: tally.examples.slice(0, 8).map((e) => ({
        file: e.file,
        line: e.line,
      })),
      data: {
        discarded: tally.discarded,
        total: tally.total,
        documented: tally.documented,
      },
      estimatedFixMinutes: Math.min(180, tally.discarded * 10),
    },
  ];
}

// ---------------------------------------------------------------------------

function tallyHandlers(ctx: AnalysisContext): HandlerTally {
  const tally: HandlerTally = {
    total: 0,
    discarded: 0,
    documented: 0,
    byFile: new Map(),
    examples: [],
  };

  for (const file of ctx.files.sourceFiles()) {
    const jsTs = ctx.asts.get(file.relPath);
    if (jsTs) {
      countJsTs(jsTs, tally);
      continue;
    }
    /*
     * Python only. Go returns errors as values and Rust uses `Result`, so
     * neither has a construct this signal describes — and calling the Python
     * matcher on them would find no `except_clause` and quietly contribute
     * nothing to the denominator, which reads as "no handlers here" rather
     * than "we do not measure this language".
     */
    const structural = ctx.structural.get(file.relPath);
    if (structural?.language === "python") countPython(structural, tally);
  }

  return tally;
}

type HandlerKind = "empty" | "log-only" | "documented" | "handled";

function record(
  tally: HandlerTally,
  file: string,
  line: number,
  kind: HandlerKind,
): void {
  tally.total++;
  const counts = tally.byFile.get(file) ?? { total: 0, discarded: 0 };
  counts.total++;

  if (kind === "documented") tally.documented++;
  if (kind === "empty" || kind === "log-only") {
    tally.discarded++;
    counts.discarded++;
    if (tally.examples.length < 8) tally.examples.push({ file, line, kind });
  }

  tally.byFile.set(file, counts);
}

function countJsTs(parsed: ParsedFile, tally: HandlerTally): void {
  for (const clause of collect(parsed.program, "CatchClause")) {
    const body = clause["body"] as AstNode | undefined;
    const statements = (body?.["body"] as AstNode[] | undefined) ?? [];
    const line = parsed.lineMap.lineAt(clause.start);

    if (statements.length === 0) {
      const explained =
        (body ? hasCommentInside(parsed.comments, body) : false) ||
        isIgnoredBinding(clause["param"] as AstNode | undefined);
      record(tally, parsed.relPath, line, explained ? "documented" : "empty");
      continue;
    }

    record(
      tally,
      parsed.relPath,
      line,
      statements.every(isLogCall) ? "log-only" : "handled",
    );
  }
}

function isLogCall(statement: AstNode): boolean {
  if (statement.type !== "ExpressionStatement") return false;
  const expression = statement["expression"] as AstNode | undefined;
  if (!expression || expression.type !== "CallExpression") return false;

  const path = memberPath(expression["callee"] as AstNode | undefined);
  if (!path) return false;
  return LOG_ROOTS.has(path.split(".")[0]!);
}

/** Does any comment fall inside this block's source range? */
function hasCommentInside(comments: Comment[], block: AstNode): boolean {
  return comments.some((c) => c.start >= block.start && c.end <= block.end);
}

/** `catch (_err)` — the conventional way to write "ignored on purpose". */
function isIgnoredBinding(param: AstNode | undefined): boolean {
  if (!param || param.type !== "Identifier") return false;
  return String(param["name"] ?? "").startsWith("_");
}

function countPython(file: StructuralFile, tally: HandlerTally): void {
  for (const clause of collectNamed(file.tree.rootNode, "except_clause")) {
    const block = childOfType(clause, "block");
    if (!block) continue;

    const statements: TsNode[] = [];
    for (let i = 0; i < block.namedChildCount; i++) {
      const child = block.namedChild(i);
      if (child) statements.push(child);
    }

    const line = clause.startPosition.row + 1;
    const meaningful = statements.filter((s) => s.type !== "comment");

    if (meaningful.length === 0 || meaningful.every(isPythonNoop)) {
      // tree-sitter keeps comments as nodes, so unlike the JS path the presence
      // of an explanation is visible directly in the children.
      const explained = statements.some((s) => s.type === "comment");
      record(tally, file.relPath, line, explained ? "documented" : "empty");
      continue;
    }

    record(
      tally,
      file.relPath,
      line,
      meaningful.every(isPythonLogCall) ? "log-only" : "handled",
    );
  }
}

/** `pass` and a bare `...` both mean "deliberately nothing". */
function isPythonNoop(node: TsNode): boolean {
  if (node.type === "pass_statement") return true;
  return node.type === "expression_statement" && node.text.trim() === "...";
}

function isPythonLogCall(node: TsNode): boolean {
  if (node.type !== "expression_statement") return false;
  const call = node.namedChild(0);
  if (!call || call.type !== "call") return false;
  const target = call.childForFieldName("function");
  return target ? PYTHON_LOG_CALLS.test(target.text) : false;
}

function childOfType(node: TsNode, type: string): TsNode | null {
  for (let i = 0; i < node.namedChildCount; i++) {
    const child = node.namedChild(i);
    if (child?.type === type) return child;
  }
  return null;
}

import type { Signal } from "@vibe/shared";

import {
  collect,
  memberPath,
  walk,
  type AstNode,
  type ParsedFile,
} from "../../index/ast";
import { collectNamed, type PythonFile } from "../../index/python";
import { ramp, type AnalysisContext } from "../context";

/**
 * Two related tells: comments that restate the line beneath them, and tests that
 * assert nothing beyond "the mock I just configured was called".
 *
 * Both are what narration looks like when the writer is explaining its own output
 * rather than recording something a future reader would not be able to infer.
 */

export const WEIGHTS = {
  obviousComments: 1.5,
  tautologicalTests: 1.5,
} as const;

const STOPWORDS = new Set([
  "the", "a", "an", "to", "for", "of", "and", "or", "this", "that", "is", "are",
  "we", "it", "in", "on", "with", "from", "all", "our", "then", "if", "as", "by",
  "into", "up", "out", "new", "its", "be", "will", "now", "here", "each", "any",
]);

/** Split identifiers into their component words: `fetchUserById` → fetch,user,by,id. */
function identifierWords(text: string): Set<string> {
  const words = new Set<string>();
  for (const raw of text.match(/[A-Za-z_$][A-Za-z0-9_$]*/g) ?? []) {
    for (const part of raw
      .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
      .replace(/[_$]+/g, " ")
      .toLowerCase()
      .split(/\s+/)) {
      if (part.length > 1) words.add(part);
    }
  }
  return words;
}

function commentWords(text: string): string[] {
  return text
    .replace(/[^A-Za-z0-9\s]/g, " ")
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .toLowerCase()
    .split(/\s+/)
    .filter((w) => w.length > 1 && !STOPWORDS.has(w));
}

/** Directive and tooling comments are never "obvious narration". */
const DIRECTIVE_RE =
  /^\s*(eslint|ts-|@ts-|prettier|biome|istanbul|c8|v8|global|jshint|oxlint|deno-|webpackChunkName|#region|#endregion|TODO|FIXME|HACK|NOTE|XXX)/i;

export interface ObviousCommentHit {
  file: string;
  line: number;
  comment: string;
}

/**
 * The code a comment is describing: the same line when the comment trails code,
 * otherwise the next non-blank line. Returns null when there is no code to compare
 * against (a trailing block of commentary, or a comment at end of file).
 */
function codeNearComment(
  source: string,
  start: number,
  end: number,
): string | null {
  const lineStart = source.lastIndexOf("\n", start) + 1;
  const before = source.slice(lineStart, start).trim();
  if (before !== "") return before;

  let cursor = source.indexOf("\n", end);
  while (cursor !== -1) {
    let lineEnd = source.indexOf("\n", cursor + 1);
    if (lineEnd === -1) lineEnd = source.length;
    const line = source.slice(cursor + 1, lineEnd).trim();
    if (line !== "") {
      // Consecutive comment lines are one block, not code.
      return line.startsWith("//") || line.startsWith("*") || line.startsWith("/*")
        ? null
        : line;
    }
    if (lineEnd >= source.length) break;
    cursor = lineEnd;
  }
  return null;
}

/** A comment reduced to what this signal needs, whichever parser produced it. */
export interface CommentRef {
  /** Comment body, delimiters already stripped where the parser does so. */
  text: string;
  start: number;
  end: number;
  line: number;
}

export function findObviousComments(
  parsed: ParsedFile,
  source: string,
): { hits: ObviousCommentHit[]; considered: number } {
  return scanComments(
    parsed.relPath,
    parsed.comments.map((c) => ({
      text: c.value,
      start: c.start,
      end: c.end,
      line: parsed.lineMap.lineAt(c.start),
    })),
    source,
  );
}

/**
 * The comparison itself is language-agnostic: it asks whether a comment's words
 * merely restate the identifiers on the line it sits against. Only the source of
 * the comments differs between parsers.
 */
export function scanComments(
  relPath: string,
  comments: CommentRef[],
  source: string,
): { hits: ObviousCommentHit[]; considered: number } {
  const hits: ObviousCommentHit[] = [];
  let considered = 0;

  for (const comment of comments) {
    // tree-sitter includes the leading `#`; oxc already strips its delimiters.
    const text = comment.text.replace(/^#+/, "").trim();
    if (text.length < 4 || DIRECTIVE_RE.test(text)) continue;

    const words = commentWords(text);
    // Very long comments are explaining something; only short narration counts.
    if (words.length === 0 || words.length > 8) continue;

    const nearbyCode = codeNearComment(source, comment.start, comment.end);
    if (nearbyCode === null) continue;

    considered++;
    const codeWords = identifierWords(nearbyCode);
    const overlap = words.filter((w) => codeWords.has(w)).length;

    if (overlap / words.length >= 0.6) {
      hits.push({ file: relPath, line: comment.line, comment: text });
    }
  }

  return { hits, considered };
}

/** Python comments, via tree-sitter. Docstrings are string nodes, not comments. */
export function findPythonObviousComments(
  parsed: PythonFile,
  source: string,
): { hits: ObviousCommentHit[]; considered: number } {
  const comments = collectNamed(parsed.tree.rootNode, "comment").map((node) => ({
    text: node.text,
    start: node.startIndex,
    end: node.endIndex,
    line: node.startPosition.row + 1,
  }));

  return scanComments(parsed.relPath, comments, source);
}

export function obviousCommentSignal(ctx: AnalysisContext): Signal {
  const id = "obvious-comments";
  let hits = 0;
  let considered = 0;
  const examples: ObviousCommentHit[] = [];

  for (const file of ctx.files.sourceFiles()) {
    const jsTs = ctx.asts.get(file.relPath);
    const python = ctx.python.get(file.relPath);

    const result = jsTs
      ? findObviousComments(jsTs, file.content)
      : python
        ? findPythonObviousComments(python, file.content)
        : null;
    if (!result) continue;

    hits += result.hits.length;
    considered += result.considered;
    for (const hit of result.hits) {
      if (examples.length < 3) examples.push(hit);
    }
  }

  if (considered < 15) {
    return {
      id,
      value: 0,
      weight: WEIGHTS.obviousComments,
      available: false,
      evidence: [],
      unavailableReason: "too few explanatory comments to judge",
    };
  }

  const ratio = hits / considered;
  const evidence: string[] = [];
  if (hits > 0) {
    evidence.push(
      `${hits} of ${considered} comments (${Math.round(ratio * 100)}%) restate the line directly below them`,
    );
    for (const ex of examples) {
      evidence.push(`${ex.file}:${ex.line} — "${ex.comment}"`);
    }
  }

  return {
    id,
    value: ramp(ratio, 0.15, 0.55),
    weight: WEIGHTS.obviousComments,
    available: true,
    evidence,
  };
}

// ---------------------------------------------------------------------------
// Tautological tests
// ---------------------------------------------------------------------------

const TEST_CALLERS = new Set(["it", "test"]);
const MOCK_ONLY_MATCHERS = new Set([
  "toHaveBeenCalled",
  "toHaveBeenCalledTimes",
  "toHaveBeenCalledWith",
  "toHaveBeenCalledOnce",
  "toBeCalled",
  "toBeCalledTimes",
  "toBeCalledWith",
]);

interface TestCase {
  name: string;
  line: number;
  assertions: number;
  mockOnlyAssertions: number;
}

/**
 * The identifier a call chain ultimately starts from: `expect` for
 * `expect(x).toBe(y)`, `t` for `t.is(a, b)`, `assert` for `assert.ok(x)`.
 */
function rootIdentifierOf(node: AstNode | undefined): string | null {
  if (!node) return null;
  if (node.type === "Identifier") return String(node["name"]);
  if (node.type === "MemberExpression") {
    return rootIdentifierOf(node["object"] as AstNode | undefined);
  }
  if (node.type === "CallExpression") {
    return rootIdentifierOf(node["callee"] as AstNode | undefined);
  }
  return null;
}

/**
 * Assertion roots across the runners people actually use. Recognising only
 * `expect(...)` made every AVA, tape, or `node:test` project report that none of
 * its tests assert anything — a false positive severe enough to distort the
 * score for any project outside the Jest/Vitest world.
 */
const ASSERTION_ROOTS = new Set([
  "expect", // Jest, Vitest, Chai
  "assert", // node:test, Chai's assert interface
  "should", // Chai should interface
  "chai",
  "sinon",
]);

/** Modules whose exports are assertions, however they get bound locally. */
const ASSERTION_MODULES =
  /^(node:)?assert(\/strict)?$|^chai$|^power-assert$|^uvu\/assert$|^expect$/;

/**
 * Locally-bound names imported from an assertion module.
 *
 * `import { equal } from 'node:assert'` binds `equal`, which matches none of the
 * roots above. That made every `node:test` project using destructured assertions
 * report zero assertions — `ai/nanoid` read as "52 of 52 test cases assert
 * nothing at all". Read from the AST rather than oxc's module record because the
 * record does not expose local alias names.
 */
function importedAssertionNames(parsed: ParsedFile): Set<string> {
  const names = new Set<string>();

  for (const decl of collect(parsed.program, "ImportDeclaration")) {
    const source = decl["source"] as AstNode | undefined;
    const from = source?.type === "Literal" ? String(source["value"]) : "";
    if (!ASSERTION_MODULES.test(from)) continue;

    for (const spec of (decl["specifiers"] as AstNode[]) ?? []) {
      const local = spec["local"] as AstNode | undefined;
      if (local?.type === "Identifier") names.add(String(local["name"]));
    }
  }

  return names;
}

function analyzeTestFile(parsed: ParsedFile): TestCase[] {
  const cases: TestCase[] = [];
  const importedAssertions = importedAssertionNames(parsed);

  for (const call of collect(parsed.program, "CallExpression")) {
    const callee = call["callee"] as AstNode | undefined;
    const calleeName = memberPath(callee) ?? "";
    const root = calleeName.split(".")[0] ?? "";
    if (!TEST_CALLERS.has(root)) continue;

    const args = (call["arguments"] as AstNode[]) ?? [];
    const nameArg = args[0];
    const body = args.find(
      (a) =>
        a.type === "ArrowFunctionExpression" || a.type === "FunctionExpression",
    );
    if (!body) continue;

    // AVA and tape pass an assertion object into the test body (`test('x', t =>
    // t.is(a, b))`). Any call on that binding counts as an assertion.
    const params = (body["params"] as AstNode[]) ?? [];
    const firstParam = params[0];
    const contextName =
      firstParam?.type === "Identifier" ? String(firstParam["name"]) : null;

    let assertions = 0;
    let mockOnly = 0;

    walk(body, {
      enter(node, ancestors) {
        if (node.type !== "CallExpression") return;

        // In `expect(x).toHaveBeenCalled()` the inner `expect(x)` is also a
        // CallExpression. Counting it would both double-count the assertion and
        // hide the matcher, which is what identifies a mock-only assertion.
        const parent = ancestors[ancestors.length - 1];
        if (parent?.type === "MemberExpression" && parent["object"] === node) {
          return;
        }

        const callee = node["callee"] as AstNode | undefined;
        const root = rootIdentifierOf(callee);
        if (!root) return;

        const isAssertion =
          ASSERTION_ROOTS.has(root) ||
          importedAssertions.has(root) ||
          (contextName !== null && root === contextName);
        if (!isAssertion) return;

        assertions++;
        if (callee?.type === "MemberExpression") {
          const property = callee["property"] as AstNode | undefined;
          const matcher =
            property?.type === "Identifier" ? String(property["name"]) : "";
          if (MOCK_ONLY_MATCHERS.has(matcher)) mockOnly++;
        }
      },
    });

    cases.push({
      name:
        nameArg?.type === "Literal" ? String(nameArg["value"]) : "<unnamed>",
      line: parsed.lineMap.lineAt(call.start),
      assertions,
      mockOnlyAssertions: mockOnly,
    });
  }

  return cases;
}

/**
 * pytest and unittest, via tree-sitter.
 *
 * Python asserts are *statements* rather than `expect()` calls, so this is a
 * different detection shape from the JS/TS version. Mock-only assertions have a
 * direct analogue: `mock.assert_called_once()` is a method call that passes
 * whenever the mock was configured, exactly like `toHaveBeenCalled`.
 */
function analyzePythonTestFile(parsed: PythonFile): TestCase[] {
  const cases: TestCase[] = [];

  for (const fn of collectNamed(parsed.tree.rootNode, "function_definition")) {
    const name = fn.childForFieldName("name")?.text ?? "";
    // pytest collects functions named test_*; unittest uses methods named the
    // same way inside a TestCase subclass.
    if (!name.startsWith("test")) continue;

    let assertions = collectNamed(fn, "assert_statement").length;
    let mockOnly = 0;

    for (const call of collectNamed(fn, "call")) {
      const fnNode = call.childForFieldName("function");
      if (!fnNode || fnNode.type !== "attribute") continue;
      const method = fnNode.childForFieldName("attribute")?.text ?? "";

      if (method.startsWith("assert")) {
        assertions++;
        if (method.startsWith("assert_called") || method === "assert_has_calls") {
          mockOnly++;
        }
      }
    }

    cases.push({
      name,
      line: fn.startPosition.row + 1,
      assertions,
      mockOnlyAssertions: mockOnly,
    });
  }

  return cases;
}

export function tautologicalTestSignal(ctx: AnalysisContext): Signal {
  const id = "tautological-tests";
  const testFiles = ctx.files.testFiles();

  if (testFiles.length === 0) {
    return {
      id,
      value: 0,
      weight: WEIGHTS.tautologicalTests,
      available: false,
      evidence: [],
      unavailableReason: "the project has no tests",
    };
  }

  const cases: TestCase[] = [];
  for (const file of testFiles) {
    const jsTs = ctx.asts.get(file.relPath);
    if (jsTs) {
      cases.push(...analyzeTestFile(jsTs));
      continue;
    }
    const python = ctx.python.get(file.relPath);
    if (python) cases.push(...analyzePythonTestFile(python));
  }

  if (cases.length < 5) {
    return {
      id,
      value: 0,
      weight: WEIGHTS.tautologicalTests,
      available: false,
      evidence: [],
      unavailableReason: "too few test cases to judge",
    };
  }

  const empty = cases.filter((c) => c.assertions === 0).length;
  const mockOnly = cases.filter(
    (c) => c.assertions > 0 && c.mockOnlyAssertions === c.assertions,
  ).length;
  const ratio = (empty + mockOnly) / cases.length;

  const evidence: string[] = [];
  if (empty > 0) {
    evidence.push(`${empty} of ${cases.length} test cases assert nothing at all`);
  }
  if (mockOnly > 0) {
    evidence.push(
      `${mockOnly} test case(s) only assert that a mock was called, which cannot fail if the code under test is wrong`,
    );
  }

  return {
    id,
    value: ramp(ratio, 0.15, 0.6),
    weight: WEIGHTS.tautologicalTests,
    available: true,
    evidence,
  };
}

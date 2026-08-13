import type { Finding, Location, Severity, Signal } from "@vibe/shared";

import {
  collect,
  memberPath,
  type AstNode,
  type ParsedFile,
} from "../../index/ast";
import { clamp01, ramp, type AnalysisContext } from "../context";
import { countOf } from "../../format";

/**
 * Calls that hand attacker-controlled input to something that executes it, and
 * CORS configuration that lets any origin in.
 *
 * **Context decides severity, not the call.** `eval` in a build script is a
 * tool doing its job; `eval` in a request handler is a remote code execution
 * path. Judging the call alone would flag every bundler config in every
 * repository, which is the shape of false positive this project exists to
 * avoid — so a sink in build or configuration code is reported at `low` and
 * kept out of the signal's numerator entirely.
 *
 * **A literal argument is not a finding.** `execSync("git rev-parse HEAD")`
 * cannot be injected into; `execSync(\`git show ${ref}\`)` can. Every sink here
 * requires an interpolated template or a concatenation before it fires, which
 * is what separates "runs a command" from "builds a command out of input".
 *
 * JavaScript and TypeScript only. These are semantic patterns, not syntax:
 * recognising them needs to know that `exec` is `child_process.exec`, and the
 * structural tier has no such knowledge.
 */

export const WEIGHT = 2;

type SinkKind =
  | "eval"
  | "dynamic-function"
  | "shell-injection"
  | "sql-injection"
  | "raw-html"
  | "cors-wildcard";

interface SinkHit {
  kind: SinkKind;
  file: string;
  line: number;
  /** False when the call sits in build tooling, config, or a test. */
  inAppCode: boolean;
  detail: string;
}

const SINK_LABEL: Record<SinkKind, string> = {
  eval: "eval() on a value built at runtime",
  "dynamic-function": "new Function() built from a runtime value",
  "shell-injection": "shell command built by interpolation",
  "sql-injection": "SQL query built by string concatenation",
  "raw-html": "raw HTML injected from a runtime value",
  "cors-wildcard": "CORS allows any origin",
};

/** Shell execution entry points. `spawn` with an argv array is not included. */
const SHELL_CALLS = /(?:^|\.)(exec|execSync|spawnSync|spawn)$/;

/** Query entry points across the common clients. */
const QUERY_CALLS = /(?:^|\.)(query|raw|execute|unsafe)$/;

/**
 * Paths whose code never serves a request.
 *
 * Anything matching runs at build or development time, so a sink here is a
 * tool invoking a tool. Still reported — it is worth knowing — but at `low`,
 * and it does not move the score.
 */
const BUILD_CONTEXT =
  /(^|[/\\])(scripts?|bin|tools?|examples?|benchmarks?|\.config)[/\\]|\.(config|conf)\.[cm]?[jt]sx?$|(^|[/\\])(rollup|webpack|vite|esbuild|gulpfile|gruntfile|next|tailwind|postcss|vitest|jest|eslint)\.[^/\\]*$/i;

export function findSinks(ctx: AnalysisContext): SinkHit[] {
  const hits: SinkHit[] = [];

  for (const file of ctx.files.codeFiles()) {
    const parsed = ctx.asts.get(file.relPath);
    if (!parsed) continue;

    // A test that calls eval is testing eval. Excluded outright rather than
    // downgraded — the same reasoning the secret scanner uses for fixtures.
    if (file.isTest) continue;

    const inAppCode = !BUILD_CONTEXT.test(file.relPath);
    collectFrom(parsed, inAppCode, hits);
  }

  return hits;
}

function collectFrom(
  parsed: ParsedFile,
  inAppCode: boolean,
  hits: SinkHit[],
): void {
  const at = (node: AstNode) => parsed.lineMap.lineAt(node.start);
  const push = (kind: SinkKind, node: AstNode, detail: string) =>
    hits.push({
      kind,
      file: parsed.relPath,
      line: at(node),
      inAppCode,
      detail,
    });

  for (const call of collect(parsed.program, "CallExpression")) {
    const callee = call["callee"] as AstNode | undefined;
    const args = (call["arguments"] as AstNode[]) ?? [];
    const path = memberPath(callee) ?? "";
    const first = args[0];

    if (callee?.type === "Identifier" && callee["name"] === "eval") {
      // `eval` on a literal is inert and vanishingly rare; on anything else it
      // executes whatever produced the value.
      if (first && !isStaticString(first)) push("eval", call, "eval()");
      continue;
    }

    /*
     * `cors()` with no arguments is the permissive default — the library's own
     * docs describe it as reflecting any origin. `cors({ origin: true })` is
     * the same thing spelled out, and is caught by the object scan below.
     */
    if (callee?.type === "Identifier" && callee["name"] === "cors") {
      if (args.length === 0) {
        push("cors-wildcard", call, "cors() with no configuration");
      }
      continue;
    }

    if (SHELL_CALLS.test(path) && first && isBuiltFromInput(first)) {
      push("shell-injection", call, `${path}()`);
      continue;
    }

    if (QUERY_CALLS.test(path) && first && isBuiltFromInput(first)) {
      push("sql-injection", call, `${path}()`);
    }
  }

  for (const created of collect(parsed.program, "NewExpression")) {
    const callee = created["callee"] as AstNode | undefined;
    if (callee?.type !== "Identifier" || callee["name"] !== "Function") continue;
    const args = (created["arguments"] as AstNode[]) ?? [];
    if (args.some((a) => !isStaticString(a))) {
      push("dynamic-function", created, "new Function()");
    }
  }

  for (const property of collect(parsed.program, "Property")) {
    const key = keyName(property["key"] as AstNode | undefined);
    const value = property["value"] as AstNode | undefined;
    if (!key || !value) continue;

    // React's escape hatch. A literal string is a deliberate constant; anything
    // else is a value arriving from somewhere.
    if (key === "__html" && !isStaticString(value)) {
      push("raw-html", property, "dangerouslySetInnerHTML");
      continue;
    }

    if (key === "Access-Control-Allow-Origin" && literalValue(value) === "*") {
      push("cors-wildcard", property, "Access-Control-Allow-Origin: *");
      continue;
    }

    if (key === "origin") {
      const literal = literalValue(value);
      if (literal === "*" || literal === true) {
        push("cors-wildcard", property, `origin: ${JSON.stringify(literal)}`);
      }
    }
  }
}

// ---------------------------------------------------------------------------

/**
 * A template with interpolation, or a concatenation involving a non-literal.
 *
 * This is the whole false-positive defence for the two injection sinks: a
 * command or query assembled entirely from literals cannot carry input into
 * the interpreter, however alarming the function name looks.
 */
function isBuiltFromInput(node: AstNode): boolean {
  if (node.type === "TemplateLiteral") {
    return ((node["expressions"] as AstNode[]) ?? []).length > 0;
  }
  if (node.type === "BinaryExpression" && node["operator"] === "+") {
    const left = node["left"] as AstNode | undefined;
    const right = node["right"] as AstNode | undefined;
    return (
      (left ? !isStaticString(left) : false) ||
      (right ? !isStaticString(right) : false)
    );
  }
  return false;
}

/** A literal string, or a template with nothing interpolated into it. */
function isStaticString(node: AstNode): boolean {
  if (node.type === "Literal") return true;
  if (node.type === "TemplateLiteral") {
    return ((node["expressions"] as AstNode[]) ?? []).length === 0;
  }
  return false;
}

function keyName(key: AstNode | undefined): string | null {
  if (!key) return null;
  if (key.type === "Identifier") return String(key["name"]);
  if (key.type === "Literal") return String(key["value"]);
  return null;
}

function literalValue(node: AstNode): string | boolean | null {
  if (node.type !== "Literal") return null;
  const value = node["value"];
  return typeof value === "string" || typeof value === "boolean" ? value : null;
}

// ---------------------------------------------------------------------------

export function dangerousCallSignal(ctx: AnalysisContext): Signal {
  const id = "dangerous-calls";

  if (ctx.asts.parsedCount === 0) {
    return {
      id,
      value: 0,
      weight: WEIGHT,
      available: false,
      evidence: [],
      unavailableReason:
        "these checks read JavaScript and TypeScript semantics, and this project has none",
    };
  }

  const hits = findSinks(ctx);
  const app = hits.filter((h) => h.inAppCode);

  const perFile: Record<string, number> = {};
  for (const hit of app) perFile[hit.file] = 1;

  const evidence = app
    .slice(0, 5)
    .map((h) => `${h.file}:${h.line} — ${SINK_LABEL[h.kind]} (${h.detail})`);
  if (app.length > 5) evidence.push(`and ${app.length - 5} more`);

  const inBuild = hits.length - app.length;
  if (inBuild > 0) {
    // Said out loud, because silently dropping them would leave a reader who
    // knows their build script uses `exec` wondering what else was skipped.
    evidence.push(
      `${countOf(inBuild, "similar call")} in build scripts or config were not counted`,
    );
  }

  const wildcardCors = app.some((h) => h.kind === "cors-wildcard");

  return {
    id,
    /*
     * One sink is a finding; three is a habit. Ramped rather than saturating
     * like the secret signals, because unlike a committed credential a single
     * `eval` is not by itself full exposure — it depends on what reaches it,
     * which is exactly what we cannot see.
     */
    value: clamp01(Math.max(ramp(app.length, 0, 3), wildcardCors ? 0.6 : 0)),
    weight: WEIGHT,
    available: true,
    evidence,
    perFile,
  };
}

export function dangerousCallFindings(ctx: AnalysisContext): Finding[] {
  const hits = findSinks(ctx);
  if (hits.length === 0) return [];

  const byKind = new Map<SinkKind, SinkHit[]>();
  for (const hit of hits) {
    byKind.set(hit.kind, [...(byKind.get(hit.kind) ?? []), hit]);
  }

  const findings: Finding[] = [];

  for (const [kind, group] of byKind) {
    const app = group.filter((h) => h.inAppCode);
    const locations: Location[] = group
      .slice(0, 8)
      .map((h) => ({ file: h.file, line: h.line }));

    /*
     * Severity follows where the call lives, not what it is. Everything in
     * build tooling stays `low` however dangerous the function name — that is
     * the difference between a finding and a false positive here.
     */
    const severity: Severity = app.length === 0 ? "low" : "medium";

    findings.push({
      ruleId: "dangerous-call",
      dimension: "security",
      severity,
      // Syntax is certain; whether input actually reaches the sink is not, and
      // that is the part that decides whether it is exploitable.
      confidence: "medium",
      source: "builtin",
      title:
        group.length === 1
          ? SINK_LABEL[kind]
          : `${SINK_LABEL[kind]} — ${group.length} places`,
      locations,
      data: {
        kind,
        occurrences: group.length,
        inAppCode: app.length,
        inBuildTooling: group.length - app.length,
      },
      estimatedFixMinutes: 20 * Math.min(group.length, 6),
    });
  }

  return findings;
}

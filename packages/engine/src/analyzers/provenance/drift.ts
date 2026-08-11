import type { Signal } from "@vibe/shared";

import { collect, memberPath, walk, type AstNode, type ParsedFile } from "../../index/ast";
import { ramp, type AnalysisContext } from "../context";

/**
 * Convention drift between files.
 *
 * A codebase written by one person converges on habits: one error-handling idiom,
 * one export style, one way of declaring functions. A codebase assembled one file
 * per agent session does not — each file is internally consistent but disagrees
 * with its neighbours, because each was written without reference to the others.
 *
 * Formatting-only dimensions (quotes, semicolons) are dropped when a formatter
 * config is present, since Prettier would flatten them regardless of authorship.
 */

export const WEIGHT = 2;

type Choice = string;

interface Dimension {
  id: string;
  label: string;
  /** Returns the file's dominant choice, or null when it does not apply. */
  classify(parsed: ParsedFile, source: string): Choice | null;
  /** Skip when the repo has an autoformatter. */
  formattingOnly?: boolean;
}

const DIMENSIONS: Dimension[] = [
  {
    id: "quotes",
    label: "string quote style",
    formattingOnly: true,
    classify(parsed, source) {
      let single = 0;
      let double = 0;
      for (const node of collect(parsed.program, "Literal")) {
        if (typeof node["value"] !== "string") continue;
        const first = source[node.start];
        if (first === "'") single++;
        else if (first === '"') double++;
      }
      if (single + double < 3) return null;
      return single > double ? "single" : "double";
    },
  },
  {
    id: "semicolons",
    label: "semicolon use",
    formattingOnly: true,
    classify(parsed, source) {
      let withSemi = 0;
      let without = 0;
      for (const node of collect(parsed.program, [
        "ExpressionStatement",
        "VariableDeclaration",
        "ReturnStatement",
      ])) {
        if (source[node.end - 1] === ";") withSemi++;
        else without++;
      }
      if (withSemi + without < 3) return null;
      return withSemi > without ? "semicolons" : "no-semicolons";
    },
  },
  {
    id: "error-handling",
    label: "error handling idiom",
    classify(parsed) {
      const tryCount = collect(parsed.program, "TryStatement").length;
      let catchChains = 0;
      for (const call of collect(parsed.program, "CallExpression")) {
        const path = memberPath(call["callee"] as AstNode | undefined);
        if (path?.endsWith(".catch")) catchChains++;
      }
      const asyncCalls = collect(parsed.program, "AwaitExpression").length;
      if (tryCount === 0 && catchChains === 0) {
        // Only meaningful for files that actually do async work.
        return asyncCalls > 0 ? "unhandled" : null;
      }
      return tryCount >= catchChains ? "try-catch" : "promise-catch";
    },
  },
  {
    id: "async-style",
    label: "async style",
    classify(parsed) {
      const awaits = collect(parsed.program, "AwaitExpression").length;
      let thens = 0;
      for (const call of collect(parsed.program, "CallExpression")) {
        const path = memberPath(call["callee"] as AstNode | undefined);
        if (path?.endsWith(".then")) thens++;
      }
      if (awaits + thens < 2) return null;
      return awaits >= thens ? "async-await" : "promise-chain";
    },
  },
  {
    id: "export-style",
    label: "export style",
    classify(parsed) {
      const named = collect(parsed.program, "ExportNamedDeclaration").length;
      const def = collect(parsed.program, "ExportDefaultDeclaration").length;
      if (named + def === 0) return null;
      return def > named ? "default" : "named";
    },
  },
  {
    id: "function-style",
    label: "function declaration style",
    classify(parsed) {
      let declarations = 0;
      let arrowConsts = 0;
      walk(parsed.program, {
        enter(node, ancestors) {
          if (node.type === "FunctionDeclaration") declarations++;
          if (node.type === "ArrowFunctionExpression") {
            const parent = ancestors[ancestors.length - 1];
            if (parent?.type === "VariableDeclarator") arrowConsts++;
          }
        },
      });
      if (declarations + arrowConsts < 2) return null;
      return declarations > arrowConsts ? "function-decl" : "arrow-const";
    },
  },
];

const FORMATTER_CONFIGS = [
  ".prettierrc",
  ".prettierrc.json",
  ".prettierrc.js",
  ".prettierrc.cjs",
  ".prettierrc.yaml",
  ".prettierrc.yml",
  "prettier.config.js",
  "prettier.config.cjs",
  "prettier.config.mjs",
  "biome.json",
  "biome.jsonc",
  ".editorconfig",
];

function hasFormatter(ctx: AnalysisContext): boolean {
  if (FORMATTER_CONFIGS.some((name) => ctx.files.has(name))) return true;
  return Object.keys(ctx.frameworks.dependencies).some(
    (dep) => dep === "prettier" || dep === "@biomejs/biome",
  );
}

export function conventionDriftSignal(ctx: AnalysisContext): Signal {
  const id = "convention-drift";
  const formatted = hasFormatter(ctx);
  const active = DIMENSIONS.filter((d) => !(d.formattingOnly && formatted));

  const sourceFiles = ctx.files
    .sourceFiles()
    .map((f) => ({ file: f, parsed: ctx.asts.get(f.relPath) }))
    .filter((x): x is { file: typeof x.file; parsed: ParsedFile } => !!x.parsed);

  if (sourceFiles.length < 8) {
    return {
      id,
      value: 0,
      weight: WEIGHT,
      available: false,
      evidence: [],
      unavailableReason: "too few source files to compare conventions",
    };
  }

  const scored: { label: string; minority: number; detail: string }[] = [];

  for (const dimension of active) {
    const counts = new Map<Choice, number>();
    let applicable = 0;

    for (const { file, parsed } of sourceFiles) {
      const choice = dimension.classify(parsed, file.content);
      if (choice === null) continue;
      applicable++;
      counts.set(choice, (counts.get(choice) ?? 0) + 1);
    }

    // Too few files to judge means unmeasured. A single choice across many files
    // means measured and perfectly consistent — a real zero, not a missing value.
    if (applicable < 6) continue;

    const sorted = [...counts.entries()].sort((a, b) => b[1] - a[1]);
    const majority = sorted[0]!;
    const minorityRatio = 1 - majority[1] / applicable;

    scored.push({
      label: dimension.label,
      minority: minorityRatio,
      detail: `${dimension.label}: ${sorted
        .map(([choice, n]) => `${choice} in ${n} file(s)`)
        .join(", ")}`,
    });
  }

  if (scored.length === 0) {
    return {
      id,
      value: 0,
      weight: WEIGHT,
      available: false,
      evidence: [],
      unavailableReason: "no comparable conventions found across files",
    };
  }

  const mean = scored.reduce((sum, s) => sum + s.minority, 0) / scored.length;
  const evidence = scored
    .filter((s) => s.minority > 0.15)
    .sort((a, b) => b.minority - a.minority)
    .slice(0, 3)
    .map((s) => s.detail);

  if (formatted) {
    evidence.push(
      "Formatting-only conventions ignored — the project uses an autoformatter",
    );
  }

  return {
    id,
    // Some disagreement is normal in any real codebase; sustained disagreement
    // across several independent dimensions is not.
    value: ramp(mean, 0.12, 0.45),
    weight: WEIGHT,
    available: true,
    evidence,
  };
}

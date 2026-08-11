import type { Finding, Signal } from "@vibe/shared";

import type { ParsedFile } from "../../index/ast";
import { isJsTsFile } from "../../ingest/guards";
import { unusedDependencies } from "../../index/frameworks";
import { ramp, type AnalysisContext } from "../context";

/**
 * Abandoned scaffolding: dependencies nothing imports, files nothing reaches, and
 * several overlapping "utils" modules that each solve part of the same problem.
 *
 * These accumulate when code is generated in bursts and never pruned — an agent
 * adds a dependency for an approach it abandons two messages later, and nothing
 * ever removes it.
 */

export const WEIGHTS = {
  unusedDependencies: 1.5,
  orphanFiles: 1.5,
  overlappingUtils: 1,
} as const;

/**
 * Files a framework or package manifest loads by convention — never imported by
 * anything, but not orphans either.
 *
 * Patterns are prefix-agnostic (`(^|/)`) rather than anchored to the repo root,
 * so a workspace package's own `packages/engine/src/index.ts` is recognised as an
 * entry point. Anchoring here made every monorepo look full of dead files.
 */
const ENTRY_POINT_PATTERNS = [
  /(^|\/)(src\/)?app\/.*\/(page|layout|route|loading|error|not-found|template|default|global-error)\.[cm]?[jt]sx?$/,
  /(^|\/)(src\/)?app\/(page|layout|route|error|loading|not-found)\.[cm]?[jt]sx?$/,
  /(^|\/)(src\/)?pages\/.*\.[cm]?[jt]sx?$/,
  /(^|\/)(src\/)?middleware\.[cm]?[jt]sx?$/,
  /(^|\/)(src\/)?instrumentation\.[cm]?[jt]sx?$/,
  /\.config\.[cm]?[jt]sx?$/,
  // Dotfile configs (`.prettierrc.js`, `.eslintrc.cjs`) are loaded by tooling
  // and never imported — they are entry points, not dead code.
  /(^|\/)\.[a-z0-9.-]+rc\.[cm]?[jt]s$/i,
  /(^|\/)(src\/)?(index|main|server|app|worker|cli)\.[cm]?[jt]sx?$/,
  /(^|\/)scripts\//,
  // Standalone runnables: you execute a benchmark or an example directly, so
  // nothing importing them is expected. zod's packages/bench/* alone accounted
  // for most of its orphan count.
  /(^|\/)(bench|benchmarks?|examples?|fixtures?|demos?)\//,
  /(^|\/)supabase\/functions\//,
  /(^|\/)(src\/)?actions?\//,
];

/** Files named directly by a package manifest's main/module/bin/exports fields. */
function manifestEntryPoints(ctx: AnalysisContext): Set<string> {
  const entries = new Set<string>();

  for (const manifestPath of ctx.frameworks.manifestPaths) {
    const manifest = ctx.files.get(manifestPath);
    if (!manifest) continue;

    let pkg: Record<string, unknown>;
    try {
      pkg = JSON.parse(manifest.content) as Record<string, unknown>;
    } catch {
      continue;
    }

    const dir = manifestPath.slice(0, manifestPath.lastIndexOf("/") + 1);
    const collectStrings = (value: unknown): void => {
      if (typeof value === "string") {
        entries.add(`${dir}${value.replace(/^\.\//, "")}`);
      } else if (value && typeof value === "object") {
        for (const nested of Object.values(value)) collectStrings(nested);
      }
    };

    for (const field of ["main", "module", "browser", "types", "bin", "exports"]) {
      collectStrings(pkg[field]);
    }
  }

  return entries;
}

function isEntryPoint(relPath: string, manifestEntries: Set<string>): boolean {
  return (
    manifestEntries.has(relPath) ||
    ENTRY_POINT_PATTERNS.some((p) => p.test(relPath))
  );
}

export function unusedDependencySignal(ctx: AnalysisContext): Signal {
  const id = "unused-dependencies";
  // Runtime deps only, so the bar is lower than it would be for deps + devDeps.
  const declared = Object.keys(ctx.frameworks.runtimeDependencies);
  if (declared.length < 5) {
    return {
      id,
      value: 0,
      weight: WEIGHTS.unusedDependencies,
      available: false,
      evidence: [],
      unavailableReason: "too few declared dependencies to judge",
    };
  }

  const imported = ctx.graph.importedPackages;
  const unused = unusedDependencies(ctx.frameworks, imported);
  const ratio = unused.length / declared.length;

  return {
    id,
    value: ramp(ratio, 0.08, 0.4),
    weight: WEIGHTS.unusedDependencies,
    available: true,
    evidence:
      unused.length === 0
        ? []
        : [
            `${unused.length} of ${declared.length} declared dependencies are never imported`,
            `Unused: ${unused.slice(0, 8).join(", ")}${unused.length > 8 ? ", …" : ""}`,
          ],
  };
}

export function orphanFileSignal(ctx: AnalysisContext): Signal {
  const id = "orphan-files";

  // Reachability is only meaningful for files whose imports we actually
  // resolve. ImportGraph understands JS/TS; a Python file has no edges at all,
  // so judging it here would report every file in every Python repository as
  // unreachable — the signal reporting its own blindness as a finding.
  const candidates = ctx.files
    .codeFiles()
    .filter((f) => !f.isTest && !f.isGenerated && isJsTsFile(f.relPath))
    .map((f) => f.relPath);

  if (candidates.length < 15) {
    return {
      id,
      value: 0,
      weight: WEIGHTS.orphanFiles,
      available: false,
      evidence: [],
      unavailableReason:
        "reachability needs resolvable imports, which we only have for JavaScript and TypeScript",
    };
  }

  const manifestEntries = manifestEntryPoints(ctx);
  const orphans = candidates.filter(
    (p) =>
      !isEntryPoint(p, manifestEntries) && ctx.graph.importersOf(p).length === 0,
  );
  const ratio = orphans.length / candidates.length;

  return {
    id,
    value: ramp(ratio, 0.05, 0.3),
    weight: WEIGHTS.orphanFiles,
    available: true,
    evidence:
      orphans.length === 0
        ? []
        : [
            `${orphans.length} of ${candidates.length} source files are never imported and are not framework entry points`,
            `Examples: ${orphans.slice(0, 5).join(", ")}`,
          ],
  };
}

const UTIL_MODULE_NAMES = new Set([
  "utils",
  "util",
  "helpers",
  "helper",
  "lib",
  "common",
  "shared",
  "misc",
  "functions",
  "tools",
  "constants",
]);

/** Export names declared by a module, from oxc's static export record. */
function exportNames(parsed: ParsedFile): string[] {
  const names: string[] = [];
  for (const record of parsed.module.staticExports ?? []) {
    for (const entry of record.entries ?? []) {
      const name = entry.exportName?.name;
      if (typeof name === "string") names.push(name);
    }
  }
  return names;
}

export function overlappingUtilsSignal(ctx: AnalysisContext): Signal {
  const id = "overlapping-utils";

  const utilModules = ctx.files
    .sourceFiles()
    .filter((f) => {
      const base = f.relPath.slice(f.relPath.lastIndexOf("/") + 1);
      const stem = base.slice(0, base.lastIndexOf(".")).toLowerCase();
      return UTIL_MODULE_NAMES.has(stem);
    })
    .map((f) => ({ path: f.relPath, parsed: ctx.asts.get(f.relPath) }))
    .filter((m): m is { path: string; parsed: ParsedFile } => !!m.parsed);

  if (utilModules.length < 2) {
    return {
      id,
      value: 0,
      weight: WEIGHTS.overlappingUtils,
      available: true,
      evidence: [],
    };
  }

  // Same export name declared by more than one grab-bag module.
  const byName = new Map<string, string[]>();
  for (const mod of utilModules) {
    for (const name of exportNames(mod.parsed)) {
      const existing = byName.get(name);
      if (existing) existing.push(mod.path);
      else byName.set(name, [mod.path]);
    }
  }
  const collisions = [...byName.entries()].filter(([, paths]) => paths.length > 1);

  const evidence: string[] = [
    `${utilModules.length} general-purpose modules: ${utilModules
      .map((m) => m.path)
      .slice(0, 6)
      .join(", ")}`,
  ];
  if (collisions.length > 0) {
    evidence.push(
      `${collisions.length} export name(s) declared in more than one of them: ${collisions
        .slice(0, 5)
        .map(([name]) => name)
        .join(", ")}`,
    );
  }

  // Three or more catch-all modules is the smell; collisions confirm it.
  const base = ramp(utilModules.length, 2, 6);
  const collisionBoost = collisions.length > 0 ? 0.3 : 0;

  return {
    id,
    value: Math.min(1, base + collisionBoost),
    weight: WEIGHTS.overlappingUtils,
    available: true,
    evidence,
  };
}

export function deadCodeFindings(ctx: AnalysisContext): Finding[] {
  const findings: Finding[] = [];

  const imported = ctx.graph.importedPackages;
  const unused = unusedDependencies(ctx.frameworks, imported);
  if (unused.length > 0) {
    findings.push({
      ruleId: "unused-dependencies",
      dimension: "health",
      severity: unused.length >= 5 ? "medium" : "low",
      confidence: "medium",
      source: "builtin",
      title: `${unused.length} declared dependencies are never imported`,
      locations: ctx.frameworks.manifestPaths.map((file) => ({ file })),
      data: { count: unused.length, packages: unused },
      estimatedFixMinutes: 10,
    });
  }

  return findings;
}

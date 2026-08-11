import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import type { ArchitectureAssessment, Metric, ScanResult } from "@vibe/shared";

import { analyzeAuthorship, type AuthorshipOptions } from "./analyzers/authorship/index";
import type { AnalysisContext } from "./analyzers/context";
import {
  GitHubError,
  fetchCommits,
  fetchRepoMeta,
  fetchTarball,
  type GitHubOptions,
  type RepoMeta,
} from "./ingest/github";
import { AstIndex } from "./index/ast";
import { FileIndex } from "./index/files";
import { detectFrameworks } from "./index/frameworks";
import { GitIndex } from "./index/git";
import { ImportGraph } from "./index/imports";
import { profileLanguages } from "./index/language";
import { PythonIndex } from "./index/python";
import { RouteTable } from "./index/routes";

export interface ScanOptions extends AuthorshipOptions {
  /** How the source arrived; determines which signals are possible. */
  kind: "github" | "zip";
  /** Display name — "owner/repo" or the uploaded filename. */
  name: string;
  /**
   * History obtained elsewhere. A source tarball contains no `.git`, so the
   * GitHub path supplies commits from the API instead. Omit for a local
   * checkout and history is read from disk.
   */
  git?: GitIndex;
}

export interface BuildContextOptions {
  git?: GitIndex;
}

/**
 * Build every index once, then run the analyzers over them.
 *
 * Index construction is the expensive part and is shared; analyzers are pure
 * functions of the context. No repo code is executed at any point.
 */
export async function buildContext(
  rootPath: string,
  options: BuildContextOptions = {},
): Promise<AnalysisContext> {
  const files = await FileIndex.build(rootPath);
  const asts = AstIndex.build(files);
  const [git, python] = await Promise.all([
    options.git ? Promise.resolve(options.git) : GitIndex.build(rootPath),
    PythonIndex.build(files),
  ]);
  const graph = ImportGraph.build(files, asts, rootPath);
  const routes = RouteTable.build(files, asts);
  const frameworks = detectFrameworks(files);
  const languages = profileLanguages(files.sourceFiles());

  return { files, asts, python, git, graph, routes, frameworks, languages };
}

export async function scanRepository(
  rootPath: string,
  options: ScanOptions,
): Promise<ScanResult> {
  const started = Date.now();
  const ctx = await buildContext(
    rootPath,
    options.git ? { git: options.git } : {},
  );
  const authorship = analyzeAuthorship(ctx, options);

  const warnings = [
    ...ctx.files.warnings,
    ...ctx.asts.warnings,
    ...ctx.python.warnings,
    ...ctx.git.warnings,
    ...ctx.routes.warnings,
    ...tierWarnings(ctx),
  ];

  return {
    schemaVersion: 1,
    repo: {
      kind: options.kind,
      name: options.name,
      rootPath,
      hasGitHistory: ctx.git.available,
      fileCount: ctx.files.fileCount,
      sourceFileCount: ctx.files.sourceFiles().length,
      totalLoc: ctx.files.totalSloc,
      frameworks: ctx.frameworks.names,
      languages: ctx.languages.shares,
      analysisTier: ctx.languages.dominantTier,
    },
    scores: [authorship.score],
    findings: authorship.findings,
    metrics: collectMetrics(ctx, authorship.clones.clonedFunctions),
    architecture: PENDING_ARCHITECTURE,
    durationMs: Date.now() - started,
    warnings,
  };
}

export interface GitHubScanOptions extends GitHubOptions, AuthorshipOptions {
  /**
   * Refuse repositories larger than this, in kilobytes as GitHub reports them.
   * A size gate up front produces an honest error; without one a large repo
   * simply exceeds the platform's function timeout with no explanation.
   */
  maxSizeKb?: number;
}

/**
 * May we scan this repository at all?
 *
 * Pure, and exported, so the two gates that must never regress can be tested
 * without touching the network.
 *
 * **The privacy check runs first, and the order is deliberate.** Reporting a
 * size for a private repository would itself disclose something about it — that
 * it exists, and roughly how big it is. Refuse before measuring.
 */
export function assertScannable(meta: RepoMeta, maxSizeKb: number): void {
  /*
   * A deployment needs a GITHUB_TOKEN for the rate limit, and that token
   * carries its owner's `repo` scope — so the API will return the owner's
   * private repositories to whoever types the slug into the public form.
   *
   * Being *able* to read a repository is never the same as the visitor being
   * *authorised* to. Without this the form becomes a lookup service for every
   * private repo the deploy token can reach, returning file paths, function
   * names and verbatim comment text.
   */
  if (meta.isPrivate) {
    throw new GitHubError(
      "That repository is private. This scanner reads public repositories only.",
      403,
    );
  }

  if (meta.sizeKb > maxSizeKb) {
    throw new GitHubError(
      `That repository is ${Math.round(meta.sizeKb / 1024)}MB, larger than the ` +
        `${Math.round(maxSizeKb / 1024)}MB limit this scanner accepts.`,
      413,
    );
  }
}

/**
 * Scan a public GitHub repository end to end.
 *
 * Source and history are fetched concurrently — they are independent requests,
 * and the tarball download dominates the wall clock.
 *
 * The checkout lives in a temp directory for the duration of the scan and is
 * removed afterwards. No repository code is executed at any point.
 */
export async function scanGitHubRepository(
  slug: string,
  options: GitHubScanOptions = {},
): Promise<ScanResult> {
  const started = Date.now();
  const maxSizeKb = options.maxSizeKb ?? 150_000;

  const meta = await fetchRepoMeta(slug, options);
  assertScannable(meta, maxSizeKb);

  const workdir = await mkdtemp(path.join(tmpdir(), "repo-audit-"));

  try {
    const [, history] = await Promise.all([
      fetchTarball(slug, workdir, options),
      fetchCommits(slug, options),
    ]);

    const result = await scanRepository(workdir, {
      kind: "github",
      name: slug,
      git: GitIndex.fromCommits(history.commits, {
        statsComplete: history.statsComplete,
        truncated: history.truncated,
      }),
      ...(options.structuralOnly ? { structuralOnly: true } : {}),
    });

    // scanRepository times only the analysis; report the whole round trip.
    return { ...result, durationMs: Date.now() - started };
  } finally {
    await rm(workdir, { recursive: true, force: true }).catch(() => {});
  }
}

/**
 * The architecture analyzer lands in a later phase. It reports
 * `insufficient-evidence` rather than a verdict so the report never implies an
 * assessment that was not actually performed.
 */
const PENDING_ARCHITECTURE: ArchitectureAssessment = {
  verdict: "insufficient-evidence",
  modularity: 0,
  moduleCount: 0,
  serviceCount: 0,
  evidence: ["Architecture analysis is not yet implemented"],
};

/**
 * Say plainly which parts of the repository could not be read.
 *
 * A language we cannot parse is a gap in the evidence, not a clean bill of
 * health, and the report must never let the two look the same.
 */
function tierWarnings(ctx: AnalysisContext): string[] {
  const out: string[] = [];
  const { shares, unparsed } = ctx.languages;

  const structural = shares.filter((s) => s.tier === "structural");
  if (structural.length > 0) {
    out.push(
      `${structural.map((s) => s.label).join(", ")} was analyzed structurally — ` +
        `duplication, comment style and test assertions only. ` +
        `Import-graph and framework checks need JavaScript or TypeScript.`,
    );
  }

  if (unparsed.length > 0) {
    const labels = shares
      .filter((s) => unparsed.includes(s.language as never))
      .map((s) => `${s.label} (${Math.round(s.share * 100)}%)`);
    out.push(
      `${labels.join(", ")} could not be parsed. Those files were judged from ` +
        `commit history and repository shape only.`,
    );
  }

  return out;
}

function collectMetrics(ctx: AnalysisContext, clonedFunctions: number): Metric[] {
  return [
    {
      id: "source-files",
      dimension: "quality",
      label: "Source files",
      value: ctx.files.sourceFiles().length,
      unit: "count",
    },
    {
      id: "source-lines",
      dimension: "quality",
      label: "Lines of source",
      value: ctx.files.totalSloc,
      unit: "loc",
    },
    {
      id: "routes",
      dimension: "security",
      label: "HTTP routes found",
      value: ctx.routes.count,
      unit: "count",
    },
    {
      id: "routes-unresolved",
      dimension: "security",
      label: "Routes whose handler could not be resolved",
      value: ctx.routes.unresolved().length,
      unit: "count",
    },
    {
      id: "duplicate-functions",
      dimension: "authorship",
      label: "Structurally duplicated functions",
      value: clonedFunctions,
      unit: "count",
    },
    {
      id: "commits",
      dimension: "authorship",
      label: "Commits analyzed",
      value: ctx.git.commitCount,
      unit: "count",
    },
  ];
}

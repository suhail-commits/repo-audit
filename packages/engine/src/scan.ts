import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import type { Metric, ScanResult } from "@vibe/shared";

import { analyzeAuthorship, type AuthorshipOptions } from "./analyzers/authorship/index";
import type { AnalysisContext } from "./analyzers/context";
import { analyzeHealth } from "./analyzers/health/index";
import {
  analyzeSecurity,
  type SecurityOptions,
} from "./analyzers/security/index";
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
import { GitIndex, checkedOutBranch } from "./index/git";
import { ImportGraph } from "./index/imports";
import { profileLanguages } from "./index/language";
import { StructuralIndex } from "./index/structural";
import { RouteTable } from "./index/routes";
import { isJsTsFile } from "./ingest/guards";
import { buildModuleGraph } from "./score/module-graph";

export interface ScanOptions
  extends AuthorshipOptions,
    SecurityOptions,
    ProgressOptions {
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

/**
 * A phase of the scan, announced as it begins.
 *
 * Carries its own label so every caller says the same thing. The web app
 * advanced six invented stage strings on a 2.2-second timer regardless of what
 * the scan was doing, which is a fiction a terminal audience notices
 * immediately — and which reported "Weighing the evidence" while the tarball
 * was still downloading.
 */
export interface ScanStage {
  id:
    | "fetching"
    | "reading"
    | "parsing"
    | "history"
    | "imports"
    | "routes"
    | "authorship"
    | "health"
    | "security";
  label: string;
}

const STAGES: Record<ScanStage["id"], string> = {
  fetching: "Fetching the repository",
  reading: "Reading every file",
  parsing: "Parsing JavaScript and TypeScript",
  history: "Reading the commit history",
  imports: "Resolving imports into a graph",
  routes: "Finding HTTP routes",
  authorship: "Weighing the authorship signals",
  health: "Re-weighting them as code health",
  security: "Checking for exposed keys, open routes and advisories",
};

/** Announce a phase, if anyone is listening. */
export function stage(
  onProgress: ((stage: ScanStage) => void) | undefined,
  id: ScanStage["id"],
): void {
  onProgress?.({ id, label: STAGES[id] });
}

export interface ProgressOptions {
  /**
   * Called as each phase begins. Synchronous and best-effort: a caller that
   * throws here would take down a scan that had otherwise succeeded, so the
   * engine never awaits it and never retries.
   */
  onProgress?: (stage: ScanStage) => void;
}

export interface BuildContextOptions extends ProgressOptions {
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
  const { onProgress } = options;

  stage(onProgress, "reading");
  const files = await FileIndex.build(rootPath);

  stage(onProgress, "parsing");
  const asts = AstIndex.build(files);

  stage(onProgress, "history");
  const [git, structural] = await Promise.all([
    options.git ? Promise.resolve(options.git) : GitIndex.build(rootPath),
    StructuralIndex.build(files),
  ]);

  stage(onProgress, "imports");
  const graph = ImportGraph.build(files, asts, rootPath);

  stage(onProgress, "routes");
  const routes = RouteTable.build(files, asts);
  const frameworks = detectFrameworks(files);
  const languages = profileLanguages(files.sourceFiles());

  return { files, asts, structural, git, graph, routes, frameworks, languages };
}

export async function scanRepository(
  rootPath: string,
  options: ScanOptions,
): Promise<ScanResult> {
  const started = Date.now();
  const { onProgress } = options;

  const ctx = await buildContext(rootPath, {
    ...(options.git ? { git: options.git } : {}),
    ...(onProgress ? { onProgress } : {}),
  });

  const branch = checkedOutBranch(rootPath);

  stage(onProgress, "authorship");
  const authorship = analyzeAuthorship(ctx, options);
  // Health re-weights the structural signals authorship already computed rather
  // than measuring them again — see `analyzers/health/index.ts`.
  stage(onProgress, "health");
  const health = analyzeHealth(ctx, authorship.score.signals);
  stage(onProgress, "security");
  const security = await analyzeSecurity(ctx, options);

  const warnings = [
    ...ctx.files.warnings,
    ...ctx.asts.warnings,
    ...ctx.structural.warnings,
    ...ctx.git.warnings,
    ...ctx.routes.warnings,
    ...tierWarnings(ctx),
    ...security.warnings,
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
      /*
       * Whatever is checked out — never a branch the caller asked for. The
       * files indexed above are the ones on disk, so naming any other branch
       * would describe a tree that was never analysed. Overwritten by
       * `scanGitHubRepository`, where source and history are fetched together
       * at one ref and the branch is therefore known to match.
       */
      ...(branch ? { branch } : {}),
      // Newest commit first, so the head of the history is the revision the
      // files on disk correspond to. Absent for a source with no history.
      ...(ctx.git.commits[0]?.sha
        ? { headSha: ctx.git.commits[0].sha }
        : {}),
    },
    // Authorship first: the narrator takes its headline from `scores[0]`.
    scores: [authorship.score, security.score, health.score],
    findings: [...authorship.findings, ...security.findings],
    metrics: collectMetrics(ctx, authorship.clones.clonedFunctions),
    /*
     * Named here in the same commit that registers each analyzer, so the report
     * can never claim a check that did not run.
     *
     * `security` is listed unconditionally even though its dependency check is
     * opt-in: an analyzer that ran and reported one signal unavailable is a
     * different thing from a dimension nobody looked at, and that distinction
     * is exactly what this array exists to carry. The unavailable signal states
     * its own reason.
     */
    analysedDimensions: ["authorship", "security", "health"],
    /*
     * Built from edges the index already resolved, so this costs a grouping
     * pass and no new parsing. Returns undefined rather than an empty graph
     * when there is nothing honest to draw — see `buildModuleGraph`.
     */
    moduleGraph: buildModuleGraph({
      files: ctx.files
        .sourceFiles()
        .map((f) => f.relPath)
        .filter(isJsTsFile),
      edges: ctx.graph.edges,
    }),
    durationMs: Date.now() - started,
    warnings,
  };
}

export interface GitHubScanOptions
  extends GitHubOptions,
    AuthorshipOptions,
    SecurityOptions,
    ProgressOptions {
  /**
   * Refuse repositories larger than this, in kilobytes as GitHub reports them.
   * A size gate up front produces an honest error; without one a large repo
   * simply exceeds the platform's function timeout with no explanation.
   */
  maxSizeKb?: number;
  /**
   * Repository metadata the caller has already fetched.
   *
   * The web app looks this up before deciding whether a stored scan is still
   * current, and hands the same object straight back here rather than letting
   * the scan fetch it a second time. Without this the freshness check would add
   * a request to *every* scan, breaking the three-request budget that keeps a
   * public deployment inside GitHub's unauthenticated rate limit.
   *
   * `assertScannable` still runs on it — the privacy and size gates are not
   * something a caller gets to skip by supplying its own metadata.
   */
  meta?: RepoMeta;
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

  const meta = options.meta ?? (await fetchRepoMeta(slug, options));
  assertScannable(meta, maxSizeKb);

  /*
   * `fetchRepoMeta` already ran for the privacy and size gates, so the default
   * branch is in hand at no request cost — which is why the report can always
   * name the branch it read, not only when one was asked for.
   */
  const ref = options.ref ?? meta.defaultBranch;
  const fetchOptions = { ...options, ref };

  const workdir = await mkdtemp(path.join(tmpdir(), "repo-audit-"));

  try {
    stage(options.onProgress, "fetching");
    // Both at the same ref, always. Fetching the tree at one and the history at
    // another would score one branch's files against another's commits.
    const [, history] = await Promise.all([
      fetchTarball(slug, workdir, fetchOptions),
      fetchCommits(slug, fetchOptions),
    ]);

    const result = await scanRepository(workdir, {
      kind: "github",
      name: slug,
      git: GitIndex.fromCommits(history.commits, {
        statsComplete: history.statsComplete,
        truncated: history.truncated,
      }),
      ...(options.structuralOnly ? { structuralOnly: true } : {}),
      ...(options.checkVulnerabilities ? { checkVulnerabilities: true } : {}),
      ...(options.osv ? { osv: options.osv } : {}),
      ...(options.onProgress ? { onProgress: options.onProgress } : {}),
    });

    return {
      ...result,
      repo: {
        ...result.repo,
        branch: ref,
        // Recorded so a later scan of the same repository can tell whether
        // anything has moved without analysing it again.
        ...(meta.pushedAt ? { pushedAt: meta.pushedAt } : {}),
      },
      // scanRepository times only the analysis; report the whole round trip.
      durationMs: Date.now() - started,
    };
  } finally {
    await rm(workdir, { recursive: true, force: true }).catch(() => {});
  }
}

/**
 * Say plainly which parts of the repository could not be read.
 *
 * A language we cannot parse is a gap in the evidence, not a clean bill of
 * health, and the report must never let the two look the same.
 */
function tierWarnings(ctx: AnalysisContext): string[] {
  const out: string[] = [];
  const { shares, unparsed } = ctx.languages;

  /*
   * The structural tier is not one thing. Python's test and error conventions
   * are wired in; Go's and Rust's are not, because `assert_eq!` and
   * `if err != nil` look nothing like the constructs those signals match.
   * Saying "analyzed structurally" for all of them would claim checks that did
   * not run, so the warning names what each language actually got.
   */
  const FULL_STRUCTURAL: readonly string[] = ["python"];

  const structural = shares.filter((s) => s.tier === "structural");
  const deep = structural.filter((s) => FULL_STRUCTURAL.includes(s.language));
  const shallow = structural.filter((s) => !FULL_STRUCTURAL.includes(s.language));

  if (deep.length > 0) {
    out.push(
      `${deep.map((s) => s.label).join(", ")} was analyzed structurally — ` +
        `duplication, comment style and test assertions only. ` +
        `Import-graph and framework checks need JavaScript or TypeScript.`,
    );
  }

  if (shallow.length > 0) {
    out.push(
      `${shallow.map((s) => s.label).join(", ")} was analyzed for duplication and ` +
        `comment style only. Test-assertion and error-handling checks are written ` +
        `against JavaScript, TypeScript and Python conventions and were not run.`,
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
      dimension: "health",
      label: "Source files",
      value: ctx.files.sourceFiles().length,
      unit: "count",
    },
    {
      id: "source-lines",
      dimension: "health",
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
      /*
       * Health, not authorship: the duplication *findings* are filed under
       * health, and a count sitting in one section while the findings it
       * counts sit in another reads as two different measurements.
       */
      id: "duplicate-functions",
      dimension: "health",
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

import { createWriteStream } from "node:fs";
import { mkdir } from "node:fs/promises";
import path from "node:path";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { createGunzip } from "node:zlib";

import { extract as tarExtract } from "tar-stream";

import type { Commit } from "../index/git";
import { LIMITS, safeArchivePath } from "./guards";

/**
 * GitHub REST API ingest.
 *
 * Replaces `git clone`: there is no `git` binary on serverless platforms, and the
 * clone was the slow part of a scan anyway (measured 1.2s clone vs 96ms analysis).
 * Fetching the tarball and the commit history as JSON needs nothing but HTTP, and
 * preserves full commit history where a shallow clone would have discarded it.
 *
 * Nothing fetched is ever executed.
 */

const API = "https://api.github.com";
const USER_AGENT = "repo-audit";

export interface GitHubOptions {
  /**
   * Personal access token or OAuth token. Raises the rate limit from 60/hour to
   * 5,000/hour. Passed per call rather than read from the environment so the
   * credential source stays pluggable.
   */
  token?: string;
  signal?: AbortSignal;
}

export interface RepoMeta {
  slug: string;
  defaultBranch: string;
  /** Repository size in kilobytes, as GitHub reports it. */
  sizeKb: number;
  primaryLanguage: string | null;
  isPrivate: boolean;
  isArchived: boolean;
  pushedAt: string | null;
}

export class GitHubError extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message);
    this.name = "GitHubError";
  }
}

const SLUG_RE = /^[A-Za-z0-9][\w.-]*\/[\w.-]+$/;

export function isValidSlug(slug: string): boolean {
  return SLUG_RE.test(slug) && !slug.includes("..");
}

function headers(opts: GitHubOptions): Record<string, string> {
  const h: Record<string, string> = {
    accept: "application/vnd.github+json",
    "user-agent": USER_AGENT,
    "x-github-api-version": "2022-11-28",
  };
  if (opts.token) h["authorization"] = `Bearer ${opts.token}`;
  return h;
}

async function request(
  url: string,
  opts: GitHubOptions,
  accept?: string,
): Promise<Response> {
  const requestHeaders = headers(opts);
  if (accept) requestHeaders["accept"] = accept;

  const response = await fetch(url, {
    headers: requestHeaders,
    ...(opts.signal ? { signal: opts.signal } : {}),
    redirect: "follow",
  });

  if (response.ok) return response;

  // Distinguish the failures a user can act on from the ones they cannot.
  if (response.status === 404) {
    throw new GitHubError(
      "Repository not found. It may be private, renamed, or misspelled.",
      404,
    );
  }
  if (response.status === 403 || response.status === 429) {
    const remaining = response.headers.get("x-ratelimit-remaining");
    throw new GitHubError(
      remaining === "0"
        ? "GitHub rate limit reached. Try again shortly."
        : "GitHub refused the request.",
      response.status,
    );
  }
  throw new GitHubError(
    `GitHub returned ${response.status} for ${url.replace(API, "")}`,
    response.status,
  );
}

export async function fetchRepoMeta(
  slug: string,
  opts: GitHubOptions = {},
): Promise<RepoMeta> {
  if (!isValidSlug(slug)) {
    throw new GitHubError(`Invalid repository slug: ${slug}`, 400);
  }

  const response = await request(`${API}/repos/${slug}`, opts);
  const body = (await response.json()) as {
    default_branch?: string;
    size?: number;
    language?: string | null;
    private?: boolean;
    archived?: boolean;
    pushed_at?: string | null;
  };

  return {
    slug,
    defaultBranch: body.default_branch ?? "HEAD",
    sizeKb: body.size ?? 0,
    primaryLanguage: body.language ?? null,
    isPrivate: body.private ?? false,
    isArchived: body.archived ?? false,
    pushedAt: body.pushed_at ?? null,
  };
}

export interface TarballResult {
  rootPath: string;
  entriesExtracted: number;
  bytesExtracted: number;
  rejected: { entry: string; reason: string }[];
  truncated: boolean;
}

/**
 * Download and extract the repository tarball.
 *
 * The same guards the zip path enforces apply here — tar has an identical attack
 * surface: entries can escape the destination with `..`, can be symlinks pointing
 * anywhere, and can expand far beyond their compressed size.
 *
 * GitHub wraps everything in a single `owner-repo-sha/` directory; that prefix is
 * stripped so paths in the report are repo-relative.
 */
export async function fetchTarball(
  slug: string,
  destDir: string,
  opts: GitHubOptions = {},
): Promise<TarballResult> {
  if (!isValidSlug(slug)) {
    throw new GitHubError(`Invalid repository slug: ${slug}`, 400);
  }

  const response = await request(
    `${API}/repos/${slug}/tarball`,
    opts,
    "application/vnd.github+json",
  );
  if (!response.body) {
    throw new GitHubError("GitHub returned an empty archive", 502);
  }

  await mkdir(destDir, { recursive: true });

  const rejected: { entry: string; reason: string }[] = [];
  let entriesExtracted = 0;
  let bytesExtracted = 0;
  let truncated = false;

  const extractor = tarExtract();

  extractor.on("entry", (header, stream, next) => {
    void (async () => {
      try {
        if (truncated) {
          stream.resume();
          next();
          return;
        }

        if (header.type !== "file") {
          // Directories are created implicitly; symlinks and hardlinks are an
          // escape vector and are never materialized.
          if (header.type === "symlink" || header.type === "link") {
            rejected.push({ entry: header.name, reason: header.type });
          }
          stream.resume();
          next();
          return;
        }

        const relative = stripArchiveRoot(header.name);
        const safe = relative ? safeArchivePath(relative) : null;
        if (!safe) {
          rejected.push({ entry: header.name, reason: "unsafe-path" });
          stream.resume();
          next();
          return;
        }

        const size = header.size ?? 0;
        if (
          entriesExtracted >= LIMITS.maxArchiveEntries ||
          bytesExtracted + size > LIMITS.maxExtractedBytes
        ) {
          truncated = true;
          stream.resume();
          next();
          return;
        }

        const outPath = path.join(destDir, safe);
        const containment = path.relative(destDir, outPath);
        if (containment.startsWith("..") || path.isAbsolute(containment)) {
          rejected.push({ entry: header.name, reason: "escapes-root" });
          stream.resume();
          next();
          return;
        }

        await mkdir(path.dirname(outPath), { recursive: true });
        await pipeline(stream, createWriteStream(outPath));

        entriesExtracted++;
        bytesExtracted += size;
        next();
      } catch (err) {
        next(err as Error);
      }
    })();
  });

  await pipeline(
    Readable.fromWeb(response.body as Parameters<typeof Readable.fromWeb>[0]),
    createGunzip(),
    extractor,
  );

  return {
    rootPath: destDir,
    entriesExtracted,
    bytesExtracted,
    rejected,
    truncated,
  };
}

/** GitHub tarballs nest everything under `owner-repo-sha/`. Drop that segment. */
function stripArchiveRoot(entryName: string): string | null {
  const normalized = entryName.replace(/\\/g, "/");
  const slash = normalized.indexOf("/");
  if (slash === -1) return null;
  const rest = normalized.slice(slash + 1);
  return rest === "" ? null : rest;
}

// ---------------------------------------------------------------------------
// Commit history
// ---------------------------------------------------------------------------

export interface CommitHistory {
  commits: Commit[];
  /**
   * False when per-file stats were not fetched for every commit. Signals that
   * need completeness (which files were touched only once) must degrade rather
   * than compute a biased answer over a sample.
   */
  statsComplete: boolean;
  /** True when the history is longer than we were willing to page through. */
  truncated: boolean;
}

export interface CommitFetchOptions extends GitHubOptions {
  /** Commits to fetch. Default 300 (three pages of 100). */
  maxCommits?: number;
}

interface CommitListEntry {
  sha: string;
  commit: {
    message: string;
    author: { name?: string; email?: string; date?: string } | null;
  };
}

/**
 * Fetch commit history and map it onto the engine's `Commit` shape.
 *
 * `Commit[]` is the seam the whole provenance analyzer sits on — every signal
 * reads only that array — so switching the source from `git log` to the API
 * changes no analyzer.
 *
 * **Request cost drove this design.** The obvious approach — list commits, then
 * `GET /commits/{sha}` for each one's stats — costs one request per commit. On a
 * 79-commit repo that is 80+ requests, which exceeds the entire unauthenticated
 * hourly budget for a single scan. GraphQL returns history *with* additions and
 * deletions in one request per 100 commits, so:
 *
 * - with a token: GraphQL, ~1-3 requests, `churn` populated
 * - without one: REST list, ~1-3 requests, no churn (GraphQL requires auth)
 *
 * Neither path yields per-commit *filenames*, so `write-once-files` always
 * degrades on the GitHub path. That is reported rather than approximated.
 */
export async function fetchCommits(
  slug: string,
  opts: CommitFetchOptions = {},
): Promise<CommitHistory> {
  if (!isValidSlug(slug)) {
    throw new GitHubError(`Invalid repository slug: ${slug}`, 400);
  }

  const maxCommits = opts.maxCommits ?? 300;

  const history = opts.token
    ? await fetchCommitsGraphql(slug, maxCommits, opts)
    : await fetchCommitsRest(slug, maxCommits, opts);

  return history;
}

interface GraphqlCommitNode {
  oid: string;
  message: string;
  committedDate: string;
  additions: number;
  deletions: number;
  author: { name?: string | null; email?: string | null } | null;
}

async function fetchCommitsGraphql(
  slug: string,
  maxCommits: number,
  opts: CommitFetchOptions,
): Promise<CommitHistory> {
  const [owner, name] = slug.split("/") as [string, string];
  const query = `
    query($owner:String!, $name:String!, $count:Int!, $after:String) {
      repository(owner:$owner, name:$name) {
        defaultBranchRef {
          target {
            ... on Commit {
              history(first:$count, after:$after) {
                pageInfo { hasNextPage endCursor }
                nodes {
                  oid message committedDate additions deletions
                  author { name email }
                }
              }
            }
          }
        }
      }
    }`;

  const nodes: GraphqlCommitNode[] = [];
  let after: string | null = null;
  let truncated = false;

  while (nodes.length < maxCommits) {
    const response = await fetch(`${API}/graphql`, {
      method: "POST",
      headers: { ...headers(opts), "content-type": "application/json" },
      body: JSON.stringify({
        query,
        variables: {
          owner,
          name,
          count: Math.min(100, maxCommits - nodes.length),
          after,
        },
      }),
      ...(opts.signal ? { signal: opts.signal } : {}),
    });

    if (!response.ok) {
      // GraphQL is an optimisation, not a requirement — fall back rather than
      // failing the scan outright.
      return fetchCommitsRest(slug, maxCommits, opts);
    }

    const body = (await response.json()) as {
      data?: {
        repository?: {
          defaultBranchRef?: {
            target?: {
              history?: {
                pageInfo?: { hasNextPage?: boolean; endCursor?: string | null };
                nodes?: GraphqlCommitNode[];
              };
            };
          };
        };
      };
      errors?: unknown[];
    };

    const historyPage =
      body.data?.repository?.defaultBranchRef?.target?.history;
    if (body.errors?.length || !historyPage?.nodes) {
      return fetchCommitsRest(slug, maxCommits, opts);
    }

    nodes.push(...historyPage.nodes);

    if (!historyPage.pageInfo?.hasNextPage) break;
    after = historyPage.pageInfo.endCursor ?? null;
    if (after === null) break;
    if (nodes.length >= maxCommits) {
      truncated = true;
      break;
    }
  }

  const commits: Commit[] = nodes.slice(0, maxCommits).map((node) => ({
    sha: node.oid,
    authorName: node.author?.name ?? "unknown",
    authorEmail: node.author?.email ?? "",
    timestamp: Date.parse(node.committedDate),
    subject: node.message.split("\n")[0] ?? "",
    body: node.message,
    // Filenames are not available; churn is, which is what commit-size needs.
    files: [],
    churn: node.additions + node.deletions,
  }));

  return { commits, statsComplete: false, truncated };
}

async function fetchCommitsRest(
  slug: string,
  maxCommits: number,
  opts: CommitFetchOptions,
): Promise<CommitHistory> {
  const perPage = 100;
  const listed: CommitListEntry[] = [];
  let truncated = false;

  for (let page = 1; listed.length < maxCommits; page++) {
    const response = await request(
      `${API}/repos/${slug}/commits?per_page=${perPage}&page=${page}`,
      opts,
    );
    const batch = (await response.json()) as CommitListEntry[];
    if (!Array.isArray(batch) || batch.length === 0) break;

    listed.push(...batch);
    if (batch.length < perPage) break;
    if (listed.length >= maxCommits) {
      truncated = true;
      break;
    }
  }

  const commits: Commit[] = listed.slice(0, maxCommits).map((entry) => {
    const author = entry.commit.author;
    return {
      sha: entry.sha,
      authorName: author?.name ?? "unknown",
      authorEmail: author?.email ?? "",
      timestamp: author?.date ? Date.parse(author.date) : 0,
      // git's %s and %B: subject is the first line, body is the whole message.
      subject: entry.commit.message.split("\n")[0] ?? "",
      body: entry.commit.message,
      files: [],
      churn: 0,
    };
  });

  return { commits, statsComplete: false, truncated };
}

import { GitHubError, fetchRepoMeta, scanGitHubRepository } from "@vibe/engine";
import {
  DIMENSIONS,
  PERSONAS,
  parseRepoSlug,
  type Dimension,
  type Persona,
} from "@vibe/shared";

import {
  checkRateLimit,
  createScan,
  latestScanFor,
  recordRequest,
} from "@/db";
import { callerHash, estimateSpend } from "@/db/limits";

export const runtime = "nodejs";
/**
 * Scans run inline rather than through a queue. Most finish in a few seconds;
 * the size gate in `scanGitHubRepository` refuses repositories large enough to
 * approach this ceiling, so a slow scan fails with an explanation rather than a
 * platform timeout.
 */
export const maxDuration = 60;

/**
 * Cheap pre-filter, not the memory ceiling.
 *
 * GitHub's `size` is the packed git object store — history, every branch, every
 * blob ever committed — which relates only loosely to how much source a scan
 * reads. It is worth checking because it is free and it avoids downloading a
 * tarball that could never be analysed, but treating it as *the* limit was a
 * mistake: it let repositories through that then exhausted the function's
 * memory, and refused ones with long histories and little code.
 *
 * The real bound is `LIMITS.maxTotalBytes` in the engine, enforced while
 * walking, where exceeding it truncates deterministically and lowers the
 * reported confidence instead of killing the process.
 */
const MAX_REPO_KB = 120_000;

/**
 * How long a stored scan is served without re-checking the repository.
 *
 * Inside this window a repeat request costs zero external calls; outside it,
 * one metadata request decides whether the stored answer is still current.
 */
const RECHECK_AFTER_MS = 5 * 60_000;

export async function POST(request: Request): Promise<Response> {
  let form: FormData;
  try {
    form = await request.formData();
  } catch {
    return json({ error: "Expected a form submission" }, 400);
  }

  const persona = readPersona(form.get("persona"));
  const focus = readFocus(form.get("focus"));
  const slug = parseRepoSlug(String(form.get("repo") ?? ""));

  if (!slug) {
    return json(
      { error: "That doesn't look like a GitHub repository. Try owner/repo." },
      400,
    );
  }

  const caller = callerHash(request);
  const auth = process.env["GITHUB_TOKEN"]
    ? { token: process.env["GITHUB_TOKEN"] }
    : {};

  try {
    /*
     * Is there already an answer for this repository, and is it still true?
     *
     * Looked up before the rate-limit check, and the order is deliberate: what
     * this request is about to cost depends on the answer, and the ceiling is
     * expressed in GitHub requests. It is one indexed local query, so a request
     * that ends up refused has still made no external call.
     */
    const previous = await latestScanFor(slug);
    const knownPushedAt = previous?.result?.repo.pushedAt;
    const withinRecheckWindow =
      previous !== null && Date.now() - previous.createdAt < RECHECK_AFTER_MS;

    /*
     * Booked before the work, not after.
     *
     * The first version counted rows in `scans`, which meant it counted
     * *results* — and both cached branches below return before a result exists.
     * Measured: 12 consecutive cached hits against a ceiling of 5, every one
     * allowed, each out-of-window hit spending a GitHub request charged to
     * nobody. Counting attempts in `request_log` is what closes that.
     */
    const about = estimateSpend({
      hasStoredScan: previous !== null,
      withinRecheckWindow,
    });

    const verdict = await checkRateLimit(caller, about);
    if (!verdict.allowed) {
      return json({ error: verdict.message }, 429);
    }
    await recordRequest(caller, about);

    /*
     * A very recent scan is served without asking GitHub anything, which makes
     * a repeatedly-requested repository free rather than merely cheap.
     *
     * Five minutes is chosen against what it risks: a repository that changed
     * in the last five minutes reported at its previous revision, with the
     * revision printed on the report either way.
     */
    if (previous && withinRecheckWindow) {
      return json({ id: previous.id, cached: true }, 200);
    }

    /*
     * Past the window, one metadata request decides it — and this is a request
     * the scan makes anyway for the privacy and size gates, so handing `meta`
     * to `scanGitHubRepository` below keeps a miss at three requests rather
     * than four.
     */
    const meta = knownPushedAt
      ? await fetchRepoMeta(slug, auth)
      : undefined;

    if (previous && meta && knownPushedAt === meta.pushedAt) {
      return json({ id: previous.id, cached: true }, 200);
    }

    const result = await scanGitHubRepository(slug, {
      // Public deployment: the dependency lookup is worth the extra requests.
      checkVulnerabilities: true,
      maxSizeKb: MAX_REPO_KB,
      ...(meta ? { meta } : {}),
      ...auth,
    });

    const id = await createScan({ slug, persona, focus, result, caller });
    return json({ id }, 201);
  } catch (err) {
    if (err instanceof GitHubError) {
      // These messages are written for the person who pasted the URL.
      return json({ error: err.message }, err.status === 413 ? 413 : 400);
    }
    console.error(`[scan] ${slug} failed:`, err);
    return json(
      { error: "Something went wrong analysing that repository." },
      500,
    );
  }
}

function readPersona(value: FormDataEntryValue | null): Persona {
  return typeof value === "string" && PERSONAS.includes(value as Persona)
    ? (value as Persona)
    : "founder";
}

/**
 * Vestigial, and kept deliberately.
 *
 * The form no longer submits a focus — the report renders every dimension, so
 * there is nothing left to select. The column is still written because rows
 * already carry it and the read path still validates it; dropping it would be a
 * migration in exchange for one unused string.
 */
function readFocus(value: FormDataEntryValue | null): Dimension {
  return typeof value === "string" && DIMENSIONS.includes(value as Dimension)
    ? (value as Dimension)
    : "authorship";
}

function json(body: unknown, status: number): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

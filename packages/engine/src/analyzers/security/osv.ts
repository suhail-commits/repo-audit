import type { InstalledPackage } from "./lockfiles";

/**
 * OSV.dev lookup for installed package versions.
 *
 * **This is the only check in the engine that touches the network**, and it is
 * the only one that can fail for reasons that have nothing to do with the
 * repository being scanned. Everything here is built around that: a timeout, a
 * bounded number of requests, and a failure mode that reports the signal
 * unavailable rather than failing the scan.
 *
 * Two-stage by necessity. `POST /v1/querybatch` answers "which of these
 * versions have advisories" for up to a thousand packages in one request, but
 * returns **ids only** — no severity, no summary. Anything readable needs
 * `GET /v1/vulns/{id}` per advisory, which is why the detail stage is capped
 * and says how many it skipped.
 *
 * Unauthenticated: OSV documents no rate limits, so unlike the GitHub API the
 * scarce resource is wall-clock inside the scan request, not quota.
 */

const OSV_ENDPOINT = "https://api.osv.dev/v1";

/** Per-request ceiling. The whole scan runs inside one serverless invocation. */
const REQUEST_TIMEOUT_MS = 8_000;

/** OSV's documented batch ceiling. */
const MAX_BATCH = 1000;

/**
 * How many advisories get their details fetched.
 *
 * One request each, so this is the number that decides whether the check costs
 * a second or half a minute. Everything beyond it is still counted and still
 * reported — as an id without a summary — never silently dropped.
 */
const MAX_DETAIL = 25;

/** Concurrent detail requests. Enough to be quick, not enough to look abusive. */
const DETAIL_CONCURRENCY = 8;

export interface Advisory {
  id: string;
  summary?: string;
  /** CVSS-derived, when OSV supplies one. */
  severity?: "critical" | "high" | "moderate" | "low";
  /** True when only the id is known because the detail budget ran out. */
  detailsSkipped: boolean;
}

export interface VulnerablePackage {
  pkg: InstalledPackage;
  advisories: Advisory[];
}

export interface OsvResult {
  vulnerable: VulnerablePackage[];
  /** Advisories whose details were not fetched because of the cap. */
  undetailed: number;
  /** Set when the lookup could not run. The signal reports this verbatim. */
  failure?: string;
}

export interface OsvOptions {
  /** Injected by tests so the suite never reaches the network. */
  fetchImpl?: typeof fetch;
  /** Skip the lookup entirely. */
  offline?: boolean;
}

export async function queryOsv(
  packages: InstalledPackage[],
  options: OsvOptions = {},
): Promise<OsvResult> {
  if (options.offline) {
    return { vulnerable: [], undetailed: 0, failure: "vulnerability lookup was disabled" };
  }
  if (packages.length === 0) {
    return { vulnerable: [], undetailed: 0 };
  }

  const call = options.fetchImpl ?? fetch;

  let matched: { pkg: InstalledPackage; ids: string[] }[];
  try {
    matched = await batchQuery(packages, call);
  } catch (err) {
    /*
     * A network failure is not a clean bill of health. Reported as an
     * unavailable signal with the reason attached, so the score is untouched
     * and confidence falls — the same treatment every other missing input
     * gets.
     */
    return {
      vulnerable: [],
      undetailed: 0,
      failure: `could not reach the vulnerability database (${describe(err)})`,
    };
  }

  if (matched.length === 0) return { vulnerable: [], undetailed: 0 };

  const ids = [...new Set(matched.flatMap((m) => m.ids))];
  const detailed = await fetchDetails(ids.slice(0, MAX_DETAIL), call);
  const undetailed = Math.max(0, ids.length - MAX_DETAIL);

  const vulnerable = matched.map(({ pkg, ids: forPkg }) => ({
    pkg,
    advisories: forPkg.map(
      (id): Advisory =>
        detailed.get(id) ?? { id, detailsSkipped: true },
    ),
  }));

  return { vulnerable, undetailed };
}

async function batchQuery(
  packages: InstalledPackage[],
  call: typeof fetch,
): Promise<{ pkg: InstalledPackage; ids: string[] }[]> {
  const out: { pkg: InstalledPackage; ids: string[] }[] = [];

  for (let start = 0; start < packages.length; start += MAX_BATCH) {
    const slice = packages.slice(start, start + MAX_BATCH);

    const response = await withTimeout((signal) =>
      call(`${OSV_ENDPOINT}/querybatch`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        signal,
        body: JSON.stringify({
          queries: slice.map((p) => ({
            version: p.version,
            package: { name: p.name, ecosystem: p.ecosystem },
          })),
        }),
      }),
    );

    if (!response.ok) {
      throw new Error(`OSV responded ${response.status}`);
    }

    const body = (await response.json()) as {
      results?: { vulns?: { id: string }[] }[];
    };

    // OSV guarantees the result order matches the input order, which is what
    // makes the positional mapping below safe.
    (body.results ?? []).forEach((result, i) => {
      const pkg = slice[i];
      const vulns = result?.vulns ?? [];
      if (pkg && vulns.length > 0) {
        out.push({ pkg, ids: vulns.map((v) => v.id) });
      }
    });
  }

  return out;
}

async function fetchDetails(
  ids: string[],
  call: typeof fetch,
): Promise<Map<string, Advisory>> {
  const found = new Map<string, Advisory>();
  if (ids.length === 0) return found;

  const queue = [...ids];
  const workers = Array.from(
    { length: Math.min(DETAIL_CONCURRENCY, queue.length) },
    async () => {
      for (;;) {
        const id = queue.shift();
        if (!id) return;
        try {
          const response = await withTimeout((signal) =>
            call(`${OSV_ENDPOINT}/vulns/${id}`, { signal }),
          );
          if (!response.ok) continue;
          const body = (await response.json()) as {
            summary?: string;
            database_specific?: { severity?: string };
          };
          found.set(id, {
            id,
            ...(body.summary ? { summary: body.summary } : {}),
            ...(normaliseSeverity(body.database_specific?.severity)
              ? { severity: normaliseSeverity(body.database_specific?.severity)! }
              : {}),
            detailsSkipped: false,
          });
        } catch {
          // One advisory failing to load is not worth failing the check for;
          // it degrades to an id without a summary, which still names the CVE.
        }
      }
    },
  );

  await Promise.all(workers);
  return found;
}

function normaliseSeverity(value: string | undefined): Advisory["severity"] {
  switch (value?.toUpperCase()) {
    case "CRITICAL":
      return "critical";
    case "HIGH":
      return "high";
    case "MODERATE":
    case "MEDIUM":
      return "moderate";
    case "LOW":
      return "low";
    default:
      return undefined;
  }
}

/**
 * Race a request against the clock, and actually cancel it when the clock wins.
 *
 * The signal has to be handed to `fetch` at the call site rather than created
 * here: an `AbortController` built around an already-started promise aborts
 * nothing. The first version did exactly that — the race returned on time while
 * the underlying request stayed open, holding the socket for the rest of the
 * serverless invocation.
 */
function withTimeout(
  run: (signal: AbortSignal) => Promise<Response>,
): Promise<Response> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);

  return run(controller.signal)
    .catch((err) => {
      if (controller.signal.aborted) {
        throw new Error(`timed out after ${REQUEST_TIMEOUT_MS}ms`);
      }
      throw err;
    })
    .finally(() => clearTimeout(timer));
}

function describe(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

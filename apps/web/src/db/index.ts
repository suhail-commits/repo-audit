import { randomUUID } from "node:crypto";

import { neon } from "@neondatabase/serverless";
import type { Dimension, Persona, ScanResult } from "@vibe/shared";

import {
  RATE_LIMITS,
  verdictFor,
  type RateLimitVerdict,
} from "./limits";
import { readScanResult } from "./migrate";

/**
 * Scan store.
 *
 * Neon over HTTP rather than a pooled TCP driver: serverless functions are
 * short-lived and would exhaust a connection pool. Scans run inline, so there is
 * no queue — a row is either a finished result or a recorded failure.
 *
 * Without `DATABASE_URL` this falls back to an in-memory store so the app runs
 * locally with nothing to set up. That store is per-process and disappears on
 * restart, which is fine for development and useless in production.
 */

export interface ScanRecord {
  id: string;
  createdAt: number;
  slug: string;
  persona: Persona;
  /** The question the visitor came to ask. Decides which section leads. */
  focus: Dimension;
  result: ScanResult | null;
  error: string | null;
  /** Curated scans shown on the landing page. */
  isExample: boolean;
  /** Salted hash of who asked for it, for rate limiting. Never the address. */
  caller: string | null;
}

export interface NewScan {
  slug: string;
  persona: Persona;
  focus: Dimension;
  result?: ScanResult;
  error?: string;
  isExample?: boolean;
  caller?: string;
}

/**
 * `CREATE TABLE IF NOT EXISTS` does nothing to a table that already exists, so
 * a new column needs its own statement — without it the deployed database keeps
 * the old shape and every insert fails on a column that is not there.
 */
const SCHEMA = `
  CREATE TABLE IF NOT EXISTS scans (
    id          UUID PRIMARY KEY,
    created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
    slug        TEXT NOT NULL,
    persona     TEXT NOT NULL,
    result      JSONB,
    error       TEXT,
    is_example  BOOLEAN NOT NULL DEFAULT FALSE
  )
`;

const MIGRATIONS = [
  `ALTER TABLE scans ADD COLUMN IF NOT EXISTS focus TEXT NOT NULL DEFAULT 'authorship'`,
  /*
   * A salted hash of the caller's address, never the address. Nullable because
   * every row written before rate limiting existed has no caller to name, and
   * inventing one would put old rows into a live bucket.
   */
  `ALTER TABLE scans ADD COLUMN IF NOT EXISTS caller TEXT`,
  /*
   * Both rate-limit counts and `latestScanFor` filter on recency, and the
   * limit check runs before every scan — the one query that must not degrade as
   * the table grows.
   */
  `CREATE INDEX IF NOT EXISTS scans_created_at_idx ON scans (created_at DESC)`,
  `CREATE INDEX IF NOT EXISTS scans_slug_created_at_idx ON scans (slug, created_at DESC)`,
  /*
   * One row per request that got past validation, whatever it went on to cost.
   *
   * Separate from `scans` because the two answer different questions. `scans`
   * records results; this records attempts, and the gap between them is where
   * the first version of the rate limiter failed — a cached answer returns
   * before a scan row exists, so counting `scans` could not see it.
   *
   * `spent` is the GitHub requests booked for the request, so the global
   * ceiling can be a budget rather than a call count. Deliberately not a
   * foreign key to `scans`: most rows here never become a scan.
   */
  `CREATE TABLE IF NOT EXISTS request_log (
     id          BIGSERIAL PRIMARY KEY,
     created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
     caller      TEXT NOT NULL,
     spent       SMALLINT NOT NULL DEFAULT 0
   )`,
  `CREATE INDEX IF NOT EXISTS request_log_created_at_idx ON request_log (created_at DESC)`,
  `CREATE INDEX IF NOT EXISTS request_log_caller_created_at_idx ON request_log (caller, created_at DESC)`,
];

type SqlClient = ReturnType<typeof neon>;

let client: SqlClient | undefined;
let schemaReady: Promise<void> | undefined;

function connectionString(): string | undefined {
  return process.env["DATABASE_URL"] ?? process.env["POSTGRES_URL"];
}

function sql(): SqlClient | null {
  const url = connectionString();
  if (!url) return null;
  client ??= neon(url);
  return client;
}

/** Created lazily and once; `CREATE TABLE IF NOT EXISTS` makes it idempotent. */
async function ensureSchema(db: SqlClient): Promise<void> {
  schemaReady ??= (async () => {
    await db.query(SCHEMA);
    for (const migration of MIGRATIONS) await db.query(migration);
  })();
  await schemaReady;
}

// ---------------------------------------------------------------------------
// In-memory fallback
// ---------------------------------------------------------------------------

/**
 * Held on `globalThis`, not in a module-scoped `const`.
 *
 * Next compiles route handlers and server components into separate module
 * instances, so a module-level Map gives the POST handler and the report page
 * two different stores — a scan is written to one and looked up in the other,
 * and every report 404s. HMR compounds it by replacing the module on each edit.
 *
 * Only affects the no-database path; with `DATABASE_URL` set nothing here runs.
 */
const memoryStore = globalThis as typeof globalThis & {
  __repoAuditScans?: Map<string, ScanRecord>;
};
memoryStore.__repoAuditScans ??= new Map<string, ScanRecord>();
const memory = memoryStore.__repoAuditScans;

let warnedAboutMemory = false;

function warnMemory(): void {
  if (warnedAboutMemory) return;
  warnedAboutMemory = true;
  console.warn(
    "[db] DATABASE_URL is not set — using an in-memory store. " +
      "Scans will not survive a restart. Set DATABASE_URL to a Neon connection string.",
  );
}

// ---------------------------------------------------------------------------

export async function createScan(input: NewScan): Promise<string> {
  const id = randomUUID();
  const db = sql();

  // Applied before either branch, so the in-memory path cannot quietly retain
  // what the database path drops — the two stores must not disagree.
  const stored = input.result ? forStorage(input.result) : null;

  if (!db) {
    warnMemory();
    memory.set(id, {
      id,
      createdAt: Date.now(),
      slug: input.slug,
      persona: input.persona,
      focus: input.focus,
      result: stored,
      error: input.error ?? null,
      isExample: input.isExample ?? false,
      caller: input.caller ?? null,
    });
    return id;
  }

  await ensureSchema(db);
  await db.query(
    `INSERT INTO scans (id, slug, persona, focus, result, error, is_example, caller)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
    [
      id,
      input.slug,
      input.persona,
      input.focus,
      stored ? JSON.stringify(stored) : null,
      input.error ?? null,
      input.isExample ?? false,
      input.caller ?? null,
    ],
  );

  return id;
}

export async function getScan(id: string): Promise<ScanRecord | null> {
  // Guard the lookup: an invalid UUID would otherwise raise a Postgres error
  // rather than simply not being found.
  if (!/^[0-9a-f-]{36}$/i.test(id)) return null;

  const db = sql();
  if (!db) {
    warnMemory();
    return memory.get(id) ?? null;
  }

  await ensureSchema(db);
  const rows = (await db.query(`SELECT * FROM scans WHERE id = $1`, [
    id,
  ])) as Record<string, unknown>[];

  const row = rows[0];
  return row ? toRecord(row) : null;
}

/** Curated scans for the landing page, newest first. */
export async function listExamples(limit = 4): Promise<ScanRecord[]> {
  const db = sql();
  if (!db) {
    warnMemory();
    return [...memory.values()]
      .filter((r) => r.isExample)
      .sort((a, b) => b.createdAt - a.createdAt)
      .slice(0, limit);
  }

  await ensureSchema(db);
  const rows = (await db.query(
    `SELECT * FROM scans WHERE is_example = TRUE ORDER BY created_at DESC LIMIT $1`,
    [limit],
  )) as Record<string, unknown>[];

  return rows.map(toRecord);
}

/**
 * The most recent finished scan of one repository.
 *
 * Only rows that actually produced a result: a failed scan is a record of an
 * attempt, and a badge rendered from one would put a number on a repository we
 * never managed to read.
 */
export async function latestScanFor(slug: string): Promise<ScanRecord | null> {
  const db = sql();
  if (!db) {
    warnMemory();
    return (
      [...memory.values()]
        .filter((r) => r.slug === slug && r.result !== null)
        .sort((a, b) => b.createdAt - a.createdAt)[0] ?? null
    );
  }

  await ensureSchema(db);
  const rows = (await db.query(
    `SELECT * FROM scans WHERE slug = $1 AND result IS NOT NULL
     ORDER BY created_at DESC LIMIT 1`,
    [slug],
  )) as Record<string, unknown>[];

  const row = rows[0];
  return row ? toRecord(row) : null;
}

/**
 * Requests logged for rate limiting. Only used without a database.
 *
 * On `globalThis` for the same reason `memoryStore` is: Next compiles route
 * handlers into separate module instances, so a module-level array would give
 * each one its own log and limit nothing.
 */
const requestStore = globalThis as typeof globalThis & {
  __repoAuditRequests?: { at: number; caller: string; spent: number }[];
};
requestStore.__repoAuditRequests ??= [];
const requestLog = requestStore.__repoAuditRequests;

/**
 * May this caller make this request right now?
 *
 * Counted off `request_log` rather than an in-process counter, because
 * serverless invocations share no memory and a module-level counter would limit
 * each cold instance separately — which is to say, not at all.
 *
 * **And off `request_log` rather than `scans`**, which is the fix this function
 * exists in its current form for. Counting stored scans meant counting results,
 * and a cached answer returns before a result is written: measured at 12
 * consecutive successes against a ceiling of 5, each out-of-window hit spending
 * a GitHub request nobody was charged for.
 *
 * Both branches compute the same two numbers and hand them to the same
 * `verdictFor`, so the store without a database cannot drift into a different
 * policy — a failure shape this project has already paid for twice.
 */
export async function checkRateLimit(
  caller: string,
  about = 0,
): Promise<RateLimitVerdict> {
  const burstMs = RATE_LIMITS.burstWindowMinutes * 60_000;
  const db = sql();

  if (!db) {
    warnMemory();
    const now = Date.now();
    return verdictFor(
      requestLog
        .filter((r) => now - r.at < 3_600_000)
        .reduce((sum, r) => sum + r.spent, 0),
      requestLog.filter((r) => r.caller === caller && now - r.at < burstMs)
        .length,
      about,
    );
  }

  await ensureSchema(db);
  const rows = (await db.query(
    `SELECT
       COALESCE(sum(spent) FILTER (
         WHERE created_at > now() - interval '1 hour'), 0)               AS spent,
       count(*) FILTER (WHERE created_at > now() - ($1 || ' minutes')::interval
                          AND caller = $2)                              AS burst
     FROM request_log`,
    [String(RATE_LIMITS.burstWindowMinutes), caller],
  )) as Record<string, unknown>[];

  const row = rows[0] ?? {};
  return verdictFor(
    Number(row["spent"] ?? 0),
    Number(row["burst"] ?? 0),
    about,
  );
}

/**
 * Book a request against the budget before doing the work it asked for.
 *
 * Recorded up front rather than after the fact so the cost is *reserved*:
 * booking on the way out would let several concurrent callers all pass the
 * check and then all start a scan, which is the case the ceiling most exists to
 * prevent.
 *
 * Curated examples are seeded by an operator rather than requested by a
 * visitor, and `seed-examples.ts` calls `createScan` directly without coming
 * through here — so seeding the landing page cannot spend the public budget.
 */
export async function recordRequest(
  caller: string,
  spent: number,
): Promise<void> {
  const db = sql();

  if (!db) {
    warnMemory();
    requestLog.push({ at: Date.now(), caller, spent });
    /*
     * Trimmed, because this array is never emptied and the process outlives any
     * window it is asked about. An hour is the longest window consulted, so
     * anything older can never change a verdict.
     */
    const cutoff = Date.now() - 3_600_000;
    while (requestLog.length > 0 && requestLog[0]!.at < cutoff) {
      requestLog.shift();
    }
    return;
  }

  await ensureSchema(db);
  await db.query(
    `INSERT INTO request_log (caller, spent) VALUES ($1, $2)`,
    [caller, spent],
  );
}

function toRecord(row: Record<string, unknown>): ScanRecord {
  const raw = row["result"];
  // jsonb comes back already parsed; a text column would not.
  const parsed =
    raw == null ? null : typeof raw === "string" ? JSON.parse(raw) : raw;

  return {
    id: String(row["id"]),
    createdAt: new Date(String(row["created_at"])).getTime(),
    slug: String(row["slug"]),
    persona: String(row["persona"]) as Persona,
    // Rows written before the column existed default to the authorship section.
    focus: (row["focus"] == null
      ? "authorship"
      : String(row["focus"])) as Dimension,
    /*
     * Never handed to the report raw. A stored row is an instance of whatever
     * the interface was the day it was written, and a field added since then is
     * `undefined` no matter what its type says — see `readScanResult`. A row it
     * cannot bring up to date becomes `null`, which the page already renders as
     * a scan that did not finish.
     */
    result: parsed === null ? null : readScanResult(parsed),
    error: row["error"] == null ? null : String(row["error"]),
    isExample: row["is_example"] === true,
    caller: row["caller"] == null ? null : String(row["caller"]),
  };
}

/**
 * Strip what must not be stored.
 *
 * `RepoInfo.rootPath` is annotated "Not persisted to the DB" and was persisted
 * anyway, because persistence happens by stringifying the whole `ScanResult`
 * and nothing along that path had an opinion about individual fields. It is an
 * absolute path inside the server's temp directory, of no use to any reader,
 * and it reached both Postgres and the browser.
 *
 * Enforced here rather than at the call site: this is the function that writes,
 * so this is the only place the claim can actually be kept.
 */
function forStorage(result: ScanResult): ScanResult {
  return { ...result, repo: { ...result.repo, rootPath: "" } };
}

import { randomUUID } from "node:crypto";

import { neon } from "@neondatabase/serverless";
import type { Persona, ScanResult } from "@vibe/shared";

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
  result: ScanResult | null;
  error: string | null;
  /** Curated scans shown on the landing page. */
  isExample: boolean;
}

export interface NewScan {
  slug: string;
  persona: Persona;
  result?: ScanResult;
  error?: string;
  isExample?: boolean;
}

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
  })();
  await schemaReady;
}

// ---------------------------------------------------------------------------
// In-memory fallback
// ---------------------------------------------------------------------------

const memory = new Map<string, ScanRecord>();
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

  if (!db) {
    warnMemory();
    memory.set(id, {
      id,
      createdAt: Date.now(),
      slug: input.slug,
      persona: input.persona,
      result: input.result ?? null,
      error: input.error ?? null,
      isExample: input.isExample ?? false,
    });
    return id;
  }

  await ensureSchema(db);
  await db.query(
    `INSERT INTO scans (id, slug, persona, result, error, is_example)
     VALUES ($1, $2, $3, $4, $5, $6)`,
    [
      id,
      input.slug,
      input.persona,
      input.result ? JSON.stringify(input.result) : null,
      input.error ?? null,
      input.isExample ?? false,
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

function toRecord(row: Record<string, unknown>): ScanRecord {
  const result = row["result"];
  return {
    id: String(row["id"]),
    createdAt: new Date(String(row["created_at"])).getTime(),
    slug: String(row["slug"]),
    persona: String(row["persona"]) as Persona,
    // jsonb comes back already parsed; a text column would not.
    result:
      result == null
        ? null
        : ((typeof result === "string"
            ? JSON.parse(result)
            : result) as ScanResult),
    error: row["error"] == null ? null : String(row["error"]),
    isExample: row["is_example"] === true,
  };
}

import { notFound } from "next/navigation";

import { DIMENSIONS, PERSONAS } from "@vibe/shared";

import { Report } from "@/components/Report";
import { getScan } from "@/db";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export default async function ScanPage({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>;
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const { id } = await params;
  const query = await searchParams;

  const scan = await getScan(id);
  if (!scan) notFound();

  /*
   * The stored value is a default, not a guarantee.
   *
   * Both of these are read from a query string *and* from a row that may
   * predate the column — the earlier version of this validated only the query
   * string and fell back to `scan.focus` unchecked, so a scan stored before
   * `focus` existed reached `dimensionLabel(undefined)` and crashed the page.
   * Validate at the boundary, both sides.
   */
  const persona = pick(query["persona"], scan.persona, PERSONAS, "founder");
  const focus = pick(query["focus"], scan.focus, DIMENSIONS, "authorship");

  if (!scan.result) {
    return (
      <main>
        <section className="hero">
          <h1>That scan didn&rsquo;t finish.</h1>
        </section>
        <div className="card stack-sm">
          <p>{scan.error ?? "The scan failed for an unknown reason."}</p>
          <p className="meta">{scan.slug}</p>
          <p>
            <a href="/">Try another repository</a>
          </p>
        </div>
      </main>
    );
  }

  return (
    <Report
      scanId={scan.id}
      result={scan.result}
      persona={persona}
      focus={focus}
    />
  );
}

/**
 * First of `requested` / `stored` that is actually one of `allowed`.
 *
 * Both inputs cross a trust boundary — one is a query string, the other a
 * database row whose shape can predate the code reading it — and neither is
 * worth trusting because TypeScript says it has a type.
 */
function pick<T extends string>(
  requested: string | string[] | undefined,
  stored: unknown,
  allowed: readonly T[],
  fallback: T,
): T {
  if (typeof requested === "string" && allowed.includes(requested as T)) {
    return requested as T;
  }
  if (typeof stored === "string" && allowed.includes(stored as T)) {
    return stored as T;
  }
  return fallback;
}

import { notFound } from "next/navigation";

import { PERSONAS, type Persona } from "@vibe/shared";

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

  // The persona chosen at submission is the default; the report's switcher
  // overrides it per view without changing the stored scan.
  const requested =
    typeof query["persona"] === "string" ? query["persona"] : undefined;
  const persona: Persona = PERSONAS.includes(requested as Persona)
    ? (requested as Persona)
    : scan.persona;

  if (!scan.result) {
    return (
      <main>
        <h2>That scan didn&rsquo;t finish.</h2>
        <div className="card">
          <p style={{ margin: 0 }}>
            {scan.error ?? "The scan failed for an unknown reason."}
          </p>
          <p className="meta" style={{ marginTop: "1rem" }}>
            {scan.slug}
          </p>
        </div>
        <p style={{ marginTop: "1.5rem" }}>
          <a href="/">Try another repository</a>
        </p>
      </main>
    );
  }

  return <Report scanId={scan.id} result={scan.result} persona={persona} />;
}

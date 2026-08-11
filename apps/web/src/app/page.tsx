import { provenanceBand } from "@vibe/shared";

import { StartScanForm } from "@/components/StartScanForm";
import { listExamples } from "@/db";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export default async function HomePage() {
  // Most visitors will never paste anything. Curated scans give them something
  // real to read, and keep the page useful when GitHub rate-limits us.
  const examples = await listExamples().catch(() => []);

  return (
    <main>
      <h2>Find out what&rsquo;s really in your codebase.</h2>
      <p className="lede">
        Point this at a repository and it will tell you how much of it was written
        by AI, and where that left gaps. Every finding comes from reading your
        code &mdash; no model is asked for an opinion, and nothing is guessed.
      </p>

      <StartScanForm />

      {examples.length > 0 ? (
        <>
          <div className="section-head">
            <h3>Or read one we prepared</h3>
          </div>
          <div className="examples">
            {examples.map((example) => {
              const score = example.result?.scores[0]?.score ?? 0;
              return (
                <a className="example" key={example.id} href={`/scan/${example.id}`}>
                  <span className="example-score">{score}</span>
                  <span>
                    <strong>{example.slug}</strong>
                    <em>{provenanceBand(score).replace("-", " ")} to be AI-generated</em>
                  </span>
                </a>
              );
            })}
          </div>
        </>
      ) : null}
    </main>
  );
}

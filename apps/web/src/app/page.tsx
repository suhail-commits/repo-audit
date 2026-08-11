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
      <section className="hero">
        <h1>How much of your codebase did AI actually write?</h1>
        <p>
          Paste a public GitHub repository. You get a score, the evidence behind
          it, and what that left behind &mdash; read from the code and the commit
          history, not guessed at.
        </p>
        <ul className="hero-note">
          <li>No sign-up, no GitHub access</li>
          <li>No model is asked for an opinion</li>
          <li>Same repo, same answer, every time</li>
        </ul>
      </section>

      <StartScanForm />

      {examples.length > 0 ? (
        <>
          <div className="section-head">
            <h3>Or read one we prepared</h3>
            <span className="meta">{examples.length} scans</span>
          </div>
          <div className="examples">
            {examples.map((example) => {
              const score = example.result?.scores[0]?.score ?? 0;
              return (
                <a
                  className="example"
                  key={example.id}
                  href={`/scan/${example.id}`}
                >
                  <span className="example-score">{score}</span>
                  <span>
                    <strong>{example.slug}</strong>
                    <em>
                      {provenanceBand(score).replace("-", " ")} to be AI-generated
                    </em>
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

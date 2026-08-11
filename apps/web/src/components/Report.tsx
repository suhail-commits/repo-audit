import { TemplateNarrator } from "@vibe/rules";
import { PERSONAS, type Persona, type ScanResult } from "@vibe/shared";

import { ScoreScale } from "@/components/ScoreScale";
import { SignalBreakdown } from "@/components/SignalBreakdown";

const narrator = new TemplateNarrator();

const PERSONA_LABELS: Record<Persona, string> = {
  founder: "Owner",
  engineer: "Engineer",
  acquirer: "Buyer",
};

/** What the provenance number is measuring, said in the reader's register. */
const SCORE_CAPTION: Record<Persona, string> = {
  founder: "how much looks AI-written",
  engineer: "provenance",
  acquirer: "AI-generation likelihood",
};

export function Report({
  scanId,
  result,
  persona,
}: {
  scanId: string;
  result: ScanResult;
  persona: Persona;
}) {
  const report = narrator.report(result, persona);
  // The narrator carries prose; the breakdown needs the raw signals, which only
  // live on the scan result.
  const provenance = result.scores.find((s) => s.dimension === "provenance");

  const measured = provenance?.signals.filter((s) => s.available).length ?? 0;
  const total = provenance?.signals.length ?? 0;

  /*
   * Only actionable findings get listed. An `info` finding like "configured for
   * AI-assisted development" is context, and the same fact already appears in
   * the evidence list above — showing it again duplicated the statement and made
   * the section count disagree with the verdict's count.
   */
  const actionable = report.findings.filter((f) => f.severity !== "info");

  return (
    <main>
      <div className="report-head">
        <span className="meta">{result.repo.name}</span>
        <div className="persona-switch">
          <span className="persona-switch-label" id="persona-label">
            Explain this for
          </span>
          <nav className="personas" aria-labelledby="persona-label">
            {PERSONAS.map((option) => (
              <a
                key={option}
                href={`/scan/${scanId}?persona=${option}`}
                aria-current={option === persona}
              >
                {PERSONA_LABELS[option]}
              </a>
            ))}
          </nav>
        </div>
      </div>

      <section className="verdict">
        <h2>{report.headline}</h2>
        <p>{report.summary}</p>
      </section>

      {provenance ? (
        <section className="score-panel">
          <ScoreScale
            score={provenance.score}
            caption={SCORE_CAPTION[persona]}
          />

          {/*
            Coverage stated as a fact, not a failure. "Some checks could not run"
            reads like something broke; it is only a statement about how much
            evidence the repository made available.
          */}
          <p className="coverage">
            Based on {measured} of {total} checks
            {total - measured > 0
              ? ` — ${total - measured} needed evidence this repository doesn't have.`
              : "."}
          </p>

          <p className="verdict-line">{report.verdict}</p>
        </section>
      ) : null}

      {report.scores.map((score) => (
        <section className="evidence-panel" key={score.dimension}>
          <h3>What we found</h3>
          {score.evidence.length > 0 ? (
            <ul className="evidence">
              {score.evidence.map((line, i) => (
                <li key={i}>{line}</li>
              ))}
            </ul>
          ) : (
            <p className="hint hint-flush">
              None of our checks found anything notable.
            </p>
          )}

          {score.caveats.map((caveat, i) => (
            <p className="caveat" key={i}>
              {caveat}
            </p>
          ))}
        </section>
      ))}

      {actionable.length > 0 ? (
        <>
          <div className="section-head">
            <h3>Worth a look</h3>
            <span className="meta">{actionable.length}</span>
          </div>

          {actionable.map((finding, i) => (
            <article className="finding" key={`${finding.ruleId}-${i}`}>
              <div className="finding-head">
                <span className={`sev sev-${finding.severity}`}>
                  {finding.severity}
                </span>
                <h4>{finding.title}</h4>
              </div>
              <p>{finding.body}</p>
              {finding.detail.map((line, j) => (
                <p className="detail" key={j}>
                  {line}
                </p>
              ))}
              {finding.locations.length > 0 ? (
                <div className="locations">
                  {finding.locations.slice(0, 6).map((loc, j) => (
                    <code key={j}>
                      {loc.file}
                      {loc.line ? `:${loc.line}` : ""}
                    </code>
                  ))}
                  {finding.locations.length > 6 ? (
                    <code>+{finding.locations.length - 6} more</code>
                  ) : null}
                </div>
              ) : null}
            </article>
          ))}
        </>
      ) : null}

      {/*
        Collapsed by default, but the summary has to advertise what is inside:
        the bars summing to the score are this tool's strongest argument that it
        is measuring rather than guessing.
      */}
      {provenance ? (
        <details className="breakdown-details">
          <summary>
            How we worked this out
            <span className="meta"> — every check, and what it contributed</span>
          </summary>
          <SignalBreakdown score={provenance} persona={persona} />
        </details>
      ) : null}

      {result.warnings.length > 0 ? (
        <div className="warnings">
          <strong>What we could and couldn&rsquo;t read</strong>
          <ul>
            {result.warnings.map((warning, i) => (
              <li key={i}>{warning}</li>
            ))}
          </ul>
        </div>
      ) : null}

      <p className="meta report-foot">
        Analysed {result.repo.sourceFileCount} source files in {result.durationMs}
        ms. No code was executed.
      </p>
    </main>
  );
}

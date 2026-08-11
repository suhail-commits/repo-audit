import { TemplateNarrator } from "@vibe/rules";
import { PERSONAS, type Persona, type ScanResult } from "@vibe/shared";

import { SignalBreakdown } from "@/components/SignalBreakdown";

const narrator = new TemplateNarrator();

const PERSONA_LABELS: Record<Persona, string> = {
  founder: "Owner",
  engineer: "Engineer",
  acquirer: "Buyer",
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

  return (
    <main>
      <div className="report-head">
        <span className="meta">{result.repo.name}</span>
        <nav className="personas" aria-label="Report detail level">
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

      <section className="verdict">
        <h2>{report.headline}</h2>
        <p>{report.summary}</p>
      </section>

      {report.scores.map((score) => (
        <section className="score-panel" key={score.dimension}>
          <div>
            <div className="score-hero">
              <span className="score-value">{score.score}</span>
              <span className="score-of">/ 100</span>
            </div>
            <span className="score-caption">{score.dimension}</span>
          </div>

          <div>
            {score.evidence.length > 0 ? (
              <ul className="evidence">
                {score.evidence.map((line, i) => (
                  <li key={i}>{line}</li>
                ))}
              </ul>
            ) : (
              <p className="hint hint-flush">
                Nothing notable was found for this measure.
              </p>
            )}

            {score.caveats.map((caveat, i) => (
              <p className="caveat" key={i}>
                {caveat}
              </p>
            ))}
          </div>
        </section>
      ))}

      {provenance ? <SignalBreakdown score={provenance} /> : null}

      {report.findings.length > 0 ? (
        <>
          <div className="section-head">
            <h3>What we found</h3>
            <span className="meta">{report.findings.length}</span>
          </div>

          {report.findings.map((finding, i) => (
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

      {result.warnings.length > 0 ? (
        <div className="warnings">
          <strong>Notes on coverage</strong>
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

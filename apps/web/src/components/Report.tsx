import { TemplateNarrator } from "@vibe/rules";
import { PERSONAS, type Persona, type ScanResult } from "@vibe/shared";

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

  return (
    <main>
      <div className="section-head" style={{ margin: "0 0 1rem" }}>
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
        <section className="card" key={score.dimension} style={{ marginBottom: "1rem" }}>
          <div className="score-row">
            <span className="score-value">{score.score}</span>
            <span className="score-label">/ 100 {score.dimension}</span>
          </div>
          <div className="meter">
            <div style={{ width: `${Math.min(100, Math.max(0, score.score))}%` }} />
          </div>

          {score.evidence.length > 0 ? (
            <ul className="evidence">
              {score.evidence.map((line, i) => (
                <li key={i}>{line}</li>
              ))}
            </ul>
          ) : (
            <p className="lede" style={{ margin: 0 }}>
              Nothing notable was found for this measure.
            </p>
          )}

          {score.caveats.map((caveat, i) => (
            <p className="caveat" key={i}>
              {caveat}
            </p>
          ))}
        </section>
      ))}

      {report.findings.length > 0 ? (
        <>
          <div className="section-head">
            <h3>What we found</h3>
            <span className="meta">{report.findings.length}</span>
          </div>

          {report.findings.map((finding, i) => (
            <article className="finding" key={`${finding.ruleId}-${i}`}>
              <header>
                <span className={`sev sev-${finding.severity}`}>{finding.severity}</span>
                <h4>{finding.title}</h4>
              </header>
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

      <p className="meta" style={{ marginTop: "2.5rem" }}>
        Analysed {result.repo.sourceFileCount} source files in {result.durationMs}ms.
        No code was executed.
      </p>
    </main>
  );
}

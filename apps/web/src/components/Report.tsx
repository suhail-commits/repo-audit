import {
  TemplateNarrator,
  dimensionLabel,
  notAnalysedHeadline,
} from "@vibe/rules";
import type { NarratedFinding, NarratedScore } from "@vibe/rules";
import {
  DIMENSIONS,
  PERSONAS,
  type Dimension,
  type Metric,
  type Persona,
  type ScanResult,
} from "@vibe/shared";

import { Hotspots } from "@/components/Hotspots";
import { ScoreScale } from "@/components/ScoreScale";
import { SignalBreakdown } from "@/components/SignalBreakdown";

const narrator = new TemplateNarrator();

const PERSONA_LABELS: Record<Persona, string> = {
  founder: "Owner",
  engineer: "Engineer",
  acquirer: "Buyer",
};

/**
 * What each number is measuring, in the reader's register.
 *
 * Both scores run the same direction — higher is more of what was measured —
 * so the health caption has to say "problems found" rather than name the
 * section, or the reader supplies the opposite meaning from the word "health".
 */
const SCORE_CAPTION: Record<Dimension, Record<Persona, string>> = {
  authorship: {
    founder: "how much looks AI-written",
    engineer: "authorship",
    acquirer: "AI-generation likelihood",
  },
  health: {
    founder: "problems found",
    engineer: "problems found — higher is worse",
    acquirer: "maintenance debt",
  },
  security: {
    founder: "problems found",
    engineer: "problems found — higher is worse",
    acquirer: "exposure",
  },
};

export function Report({
  scanId,
  result,
  persona,
  focus,
}: {
  scanId: string;
  result: ScanResult;
  persona: Persona;
  /** The question asked on the landing page. Decides which section leads. */
  focus: Dimension;
}) {
  const report = narrator.report(result, persona);

  const sectionOf = (dimension: Dimension) => ({
    dimension,
    // Numbering follows the canonical order, not the display order, so a
    // section keeps the same number whichever question was asked.
    index: DIMENSIONS.indexOf(dimension) + 1,
    findings: report.findings.filter((f) => f.dimension === dimension),
    narrated: report.scores.find((s) => s.dimension === dimension),
  });

  /*
   * One section, the one that was asked for.
   *
   * The scan computes every dimension regardless — the indexes are shared, so
   * skipping an analyzer would save almost nothing — but the page answers the
   * question that was put to it and nothing else. The switcher below is what
   * keeps the rest reachable: without it a scan would compute three answers and
   * permanently show one, with re-scanning the only way to see the others.
   */
  const shown = sectionOf(focus);

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
                // Carry the focus through, or switching persona would silently
                // send the reader back to the default section.
                href={`/scan/${scanId}?persona=${option}&focus=${focus}`}
                aria-current={option === persona}
              >
                {PERSONA_LABELS[option]}
              </a>
            ))}
          </nav>
        </div>
      </div>

      <nav className="focus-switch" aria-label="Which check to show">
        {DIMENSIONS.map((option) => (
          <a
            key={option}
            href={`/scan/${scanId}?persona=${persona}&focus=${option}`}
            aria-current={option === focus}
          >
            {dimensionLabel(option, persona).title}
            {result.analysedDimensions.includes(option) ? null : (
              <span className="focus-switch-state"> · not analysed</span>
            )}
          </a>
        ))}
      </nav>

      {/*
        The verdict counts findings across the whole report, so it belongs
        here and not inside a section. Sitting in the authorship panel it read
        as a promise about that section — "6 things are worth going through"
        directly above a section containing none of them.
      */}
      <section className="verdict">
        {/*
          The opening sentence follows the question that was asked. Leading with
          the authorship verdict above a report that opens on Code health reads
          as though the page ignored the choice.
        */}
        {/*
          The headline comes from the dimension on screen, never from a
          fallback. Falling back to the report headline put "Authorship 14/100 —
          unlikely to be AI-generated" at the top of the Security page: a
          confident answer to a question nobody asked, and none to the one they
          did.
        */}
        <h2>
          {shown.narrated?.headline ?? notAnalysedHeadline(focus, persona)}
        </h2>
        <p>{report.summary}</p>
      </section>

      <DimensionSection {...shown} persona={persona} result={result} />

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

// ---------------------------------------------------------------------------

interface Section {
  index: number;
  dimension: Dimension;
  findings: NarratedFinding[];
  narrated?: NarratedScore;
}

function DimensionSection({
  index,
  dimension,
  persona,
  result,
  findings,
  narrated,
}: Section & {
  persona: Persona;
  result: ScanResult;
}) {
  const label = dimensionLabel(dimension, persona);
  // The narrator carries prose; the breakdown needs the raw signals, which only
  // live on the scan result.
  const score = result.scores.find((s) => s.dimension === dimension);
  const metrics = result.metrics.filter((m) => m.dimension === dimension);

  /*
   * Info findings are context, not tasks. The AI-tooling note in particular
   * already appears verbatim in the evidence list, so listing it again both
   * duplicated the statement and made the section count disagree with itself.
   */
  const actionable = findings.filter((f) => f.severity !== "info");
  const analysed = result.analysedDimensions.includes(dimension);

  return (
    <section className="dimension" id={dimension}>
      <div className="dimension-head">
        <span className="dimension-index" aria-hidden="true">
          {index}
        </span>
        <div className="dimension-title">
          <h2>{label.title}</h2>
          <p className="dimension-covers">{label.covers}</p>
        </div>
        {analysed ? null : (
          <span className="dimension-state">not analysed yet</span>
        )}
      </div>

      {score ? (
        <div className="score-panel">
          <ScoreScale
            dimension={dimension}
            score={score.score}
            caption={SCORE_CAPTION[dimension][persona]}
          />

          {/*
            Coverage stated as a fact, not a failure. "Some checks could not
            run" reads like something broke; it is only a statement about how
            much evidence the repository made available.
          */}
          <Coverage
            measured={score.signals.filter((s) => s.available).length}
            total={score.signals.length}
          />
        </div>
      ) : null}

      {narrated && narrated.evidence.length > 0 ? (
        <ul className="evidence">
          {narrated.evidence.map((line, i) => (
            <li key={i}>{line}</li>
          ))}
        </ul>
      ) : null}

      {/*
        After the evidence and before the findings: it answers "where", which
        only makes sense once the reader knows what was found.
      */}
      {score ? <Hotspots score={score} persona={persona} /> : null}

      {narrated?.caveats.map((caveat, i) => (
        <p className="caveat" key={i}>
          {caveat}
        </p>
      ))}

      {dimension === "security" && !analysed ? (
        <NotBuiltYet persona={persona} metrics={metrics} />
      ) : null}

      {actionable.length > 0 ? (
        <>
          <div className="section-head">
            <h3>Worth a look</h3>
            <span className="meta">{actionable.length}</span>
          </div>
          {actionable.map((finding, i) => (
            <FindingCard finding={finding} key={`${finding.ruleId}-${i}`} />
          ))}
        </>
      ) : null}

      {/*
        A section that ran and found nothing has to say so. Left silent it is
        indistinguishable from the Security section above it, which found
        nothing because nothing looked.
      */}
      {analysed && !score && actionable.length === 0 ? (
        <p className="hint hint-flush">
          These checks ran and found nothing worth flagging.
        </p>
      ) : null}

      {metrics.length > 0 && dimension !== "security" ? (
        <Metrics metrics={metrics} />
      ) : null}

      {/*
        Collapsed by default, but the summary has to advertise what is inside:
        the bars summing to the score are this tool's strongest argument that it
        is measuring rather than guessing.
      */}
      {score ? (
        <details className="breakdown-details">
          <summary>
            How we worked this out
            <span className="meta"> — every check, and what it contributed</span>
          </summary>
          <SignalBreakdown score={score} persona={persona} />
        </details>
      ) : null}
    </section>
  );
}

function Coverage({ measured, total }: { measured: number; total: number }) {
  const missing = total - measured;
  return (
    <p className="coverage">
      Based on {measured} of {total} checks
      {missing > 0
        ? ` — ${missing} needed evidence this repository doesn't have.`
        : "."}
    </p>
  );
}

/**
 * An unbuilt section, said out loud.
 *
 * The tempting alternative is to hide the section until the analyzer exists,
 * and it is the worse one: a reader who sees an empty Security section with no
 * explanation concludes it came back clean. Naming the gap is invariant 5 —
 * report what could not be determined — applied to a whole dimension rather
 * than a single signal.
 *
 * What we *did* index is shown alongside, because the route counts are real
 * measurements and they make the boundary concrete: we can see the doors, we
 * do not yet check whether they are locked.
 */
function NotBuiltYet({
  persona,
  metrics,
}: {
  persona: Persona;
  metrics: Metric[];
}) {
  const routes = metrics.find((m) => m.id === "routes")?.value ?? 0;
  const unresolved =
    metrics.find((m) => m.id === "routes-unresolved")?.value ?? 0;

  return (
    <div className="not-built">
      <p className="not-built-lead">
        {persona === "engineer"
          ? "No security analyzer runs yet. This section is empty, not clean."
          : "We haven’t built these checks yet — so this section is empty, not a pass."}
      </p>

      {routes > 0 ? (
        <p className="not-built-measured">
          We did map <strong>{routes}</strong>{" "}
          {routes === 1 ? "HTTP route" : "HTTP routes"} in this project
          {unresolved > 0
            ? `, ${unresolved} of which we could not follow to a handler`
            : ""}
          . Whether they check who is calling them is not something we test yet.
        </p>
      ) : null}

      <p className="meta">What this section will cover</p>
      <ul className="not-built-list">
        <li>Hardcoded secrets — API keys and tokens committed to the repo</li>
        <li>Routes that never check who is calling them</li>
        <li>
          Dangerous calls — <code>eval</code>, shell commands built from input
        </li>
        <li>
          Committed <code>.env</code> files and wide-open CORS
        </li>
      </ul>
    </div>
  );
}

function Metrics({ metrics }: { metrics: Metric[] }) {
  return (
    <dl className="metrics">
      {metrics.map((metric) => (
        <div className="metric" key={metric.id}>
          <dt>{metric.label}</dt>
          <dd>{metric.value.toLocaleString()}</dd>
        </div>
      ))}
    </dl>
  );
}

function FindingCard({ finding }: { finding: NarratedFinding }) {
  return (
    <article className="finding">
      <div className="finding-head">
        <span className={`sev sev-${finding.severity}`}>{finding.severity}</span>
        <h4>{finding.title}</h4>
      </div>
      <p>{finding.body}</p>
      {finding.detail.map((line, i) => (
        <p className="detail" key={i}>
          {line}
        </p>
      ))}
      {finding.locations.length > 0 ? (
        <div className="locations">
          {finding.locations.slice(0, 6).map((loc, i) => (
            <code key={i}>
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
  );
}

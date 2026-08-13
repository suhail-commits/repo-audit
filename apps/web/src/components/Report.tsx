import { TemplateNarrator, corpusComparison, dimensionLabel } from "@vibe/rules";
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
import { ModuleMap } from "@/components/ModuleMap";
import { Priorities } from "@/components/Priorities";
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
}: {
  scanId: string;
  result: ScanResult;
  persona: Persona;
}) {
  const report = narrator.report(result, persona);

  /*
   * All three sections, in the canonical order, always.
   *
   * The page used to render one — whichever the landing page's picker had been
   * set to — with a switcher to reach the other two. That made a scan compute
   * three answers and show one, and put the reader's most useful question
   * ("anything bad in here?") behind a tab they had no reason to press. The
   * scan was always doing the work; only the report was rationing it.
   */
  const sections = DIMENSIONS.map((dimension, i) => ({
    dimension,
    index: i + 1,
    findings: report.findings.filter((f) => f.dimension === dimension),
    narrated: report.scores.find((s) => s.dimension === dimension),
  }));

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

      {/*
        The verdict spans the whole report, so it belongs here and not inside a
        section. Sitting in the authorship panel it read as a promise about that
        section — "6 things are worth going through" directly above a section
        containing none of them.
      */}
      <section className="verdict">
        {/*
          The headline is the authorship one, which is the question the visitor
          came with and the one the product is named after. It is not a verdict
          on the whole report and must not be read as one — which is why the
          shortlist sits directly beneath it, where a critical security finding
          appears whatever the authorship number says.
        */}
        <h2>{report.headline}</h2>
        <p>{report.summary}</p>
        {/*
          Composed in the narrator from counted values only, and until now
          rendered nowhere but the CLI. It is the sentence that says whether any
          of this needs acting on, which is the one thing a score cannot say.
        */}
        <p className="verdict-take">{report.verdict}</p>
      </section>

      <RepoFacts result={result} />

      {/*
        Above the sections, because it is the only thing on the page that spans
        them. Everything below answers "what did you find in this area?"; this
        answers "of everything, what first?".
      */}
      <Priorities
        persona={persona}
        priorities={report.priorities}
        totalActionable={
          report.findings.filter((f) => f.severity !== "info").length
        }
      />

      {sections.map((section) => (
        <DimensionSection
          key={section.dimension}
          {...section}
          persona={persona}
          result={result}
        />
      ))}

      {/*
        Below the section, above the warnings: it describes the whole
        repository rather than the question on screen, so it does not belong
        inside a dimension — but it is context for what was just read, not a
        preamble to it.
      */}
      {result.moduleGraph ? (
        <section className="dimension">
          <div className="section-head">
            <h3>How this codebase is put together</h3>
            <span className="meta">
              {result.moduleGraph.nodes.length} directories
            </span>
          </div>
          <ModuleMap graph={result.moduleGraph} />
        </section>
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

      {/*
        The file count moved into the facts strip at the top, so repeating it
        here left the footer saying nothing the reader had not already read
        twice. What only the footer can say is that we never ran any of it.
      */}
      <p className="meta report-foot">
        Analysed in {result.durationMs}ms. No code from this repository was
        executed &mdash; every file was read and parsed, never run.
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

          {/*
            The reference frame. The band words say what *we* call a score; this
            says what hand-written code actually scores, which is the question a
            reader looking at "21" is really asking. Measured by the sweep on
            every run and, until now, thrown away.
          */}
          <p className="corpus">
            {corpusComparison(dimension, score.score, persona)}
          </p>
        </div>
      ) : null}

      {narrated && narrated.evidence.length > 0 ? (
        <ul className="evidence">
          {narrated.evidence.map((line, i) => (
            <li key={i}>{line}</li>
          ))}
        </ul>
      ) : null}

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

      {/*
        One toggle per section, holding everything that supports the answer
        rather than being it: where it concentrates, the raw counts, and the
        per-check arithmetic.

        These used to sit open, and three sections' worth stacked on one page
        made the report mostly furniture — the two directory rankings in
        particular came out nearly identical, because health borrows the same
        per-file data authorship measured, so the same six folders were printed
        twice in a slightly different order.

        The summary has to advertise what is inside: the bars summing to the
        score are this tool's strongest argument that it measures rather than
        guesses, and a toggle nobody opens hides exactly that.
      */}
      {score ? (
        <details className="breakdown-details">
          <summary>
            How we worked this out
            <span className="meta">
              {" "}
              — every check, what it contributed, and where it concentrates
            </span>
          </summary>

          <SignalBreakdown score={score} persona={persona} />
          <Hotspots score={score} persona={persona} />
          {metrics.length > 0 ? <Metrics metrics={metrics} /> : null}
        </details>
      ) : null}
    </section>
  );
}

/**
 * What was actually looked at, stated as facts rather than buried in prose.
 *
 * **The revision is the point of this.** Everything else here is a restatement
 * of the summary sentence, but nothing on the page said *which version* of the
 * repository the numbers describe — and that is not a nicety: the same project
 * scanned locally and through the GitHub API reported 11,436 and 7,519 lines on
 * the same afternoon, because one had unpushed commits. A reader comparing the
 * report to their editor had no way to account for the difference.
 */
function RepoFacts({ result }: { result: ScanResult }) {
  const { repo } = result;
  const languages = repo.languages
    .filter((l) => l.share >= 0.05)
    .map((l) => l.label);

  const facts: { label: string; value: string }[] = [
    { label: "Source files", value: repo.sourceFileCount.toLocaleString() },
    { label: "Lines of code", value: repo.totalLoc.toLocaleString() },
  ];

  if (languages.length > 0) {
    facts.push({ label: "Languages", value: languages.slice(0, 3).join(", ") });
  }
  if (repo.frameworks.length > 0) {
    facts.push({ label: "Stack", value: repo.frameworks.slice(0, 3).join(", ") });
  }
  if (repo.headSha) {
    // Short form, as every git tool shows it. The full sha is in the title
    // attribute for anyone who needs to paste it.
    facts.push({ label: "Revision", value: repo.headSha.slice(0, 7) });
  }

  return (
    <dl className="repo-facts">
      {facts.map((fact) => (
        <div key={fact.label}>
          <dt>{fact.label}</dt>
          <dd title={fact.label === "Revision" ? repo.headSha : undefined}>
            {fact.value}
          </dd>
        </div>
      ))}
    </dl>
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

import { TemplateNarrator, corpusComparison } from "@vibe/rules";
import { authorshipBand } from "@vibe/shared";

import { ModuleMap } from "@/components/ModuleMap";
import { Priorities } from "@/components/Priorities";
import { ScoreScale } from "@/components/ScoreScale";
import { SignalBreakdown } from "@/components/SignalBreakdown";
import { StartScanForm } from "@/components/StartScanForm";
import { Act } from "@/components/landing/Act";
import { ActBlindSpots } from "@/components/landing/ActBlindSpots";
import { ActStages } from "@/components/landing/ActStages";
import { Hero } from "@/components/landing/Hero";
import { ScrollRail } from "@/components/landing/ScrollRail";
import { listExamples } from "@/db";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const narrator = new TemplateNarrator();

/**
 * The landing page shows the product working on a real repository.
 *
 * Every figure below — the module graph, the signal bars, the score, the
 * shortlist — is read from a curated scan that actually ran, not from
 * illustrative numbers written to look good. That is not squeamishness: the one
 * claim this tool makes is that every number traces to something measured, and
 * a landing page carrying invented figures would be contradicting it in the
 * largest type on the site.
 *
 * **Which means the page has to work with no scan at all.** A fresh clone with
 * no `DATABASE_URL` has no curated examples, and the honest thing to render
 * then is the argument without the evidence — the acts keep their headings and
 * lose their surfaces. It is the default state of the repository, so it is the
 * state most likely to be seen by someone running this for the first time.
 */
export default async function HomePage() {
  const examples = await listExamples().catch(() => []);

  // The newest curated scan that actually produced a result. `listExamples`
  // orders newest first, and a stored row can carry a null result if the scan
  // it recorded failed.
  const demo = examples.find((e) => e.result) ?? null;
  const result = demo?.result ?? null;

  const authorship = result?.scores.find((s) => s.dimension === "authorship") ?? null;
  const report = result ? narrator.report(result, "founder") : null;

  /*
   * Named from the stored row first, the scan second.
   *
   * Both should always be present on this path — `listExamples` only returns
   * rows a scan produced — but this string is interpolated into the largest
   * copy on the most public page in the project, and a stored row is an
   * instance of whatever the interface was the day it was written. "This one is
   * undefined." is not a sentence worth risking to save a fallback.
   */
  const subject = demo?.slug ?? result?.repo.name ?? null;

  return (
    <main className="landing">
      <ScrollRail />

      <Hero>
        <StartScanForm />
      </Hero>

      <Act
        index="01"
        title="Paste a repository. Nothing else."
        lede="No sign-up, no OAuth, no access to your account. The scan reads what is public and runs inline — usually a few seconds."
        surface="stages"
      >
        <ActStages />
      </Act>

      {result && authorship && report ? (
        <>
          <Act
            index="02"
            title="Every file, parsed exactly once."
            lede={
              subject
                ? `Imports are resolved into a real graph, then aggregated to directories. This one is ${subject}.`
                : "Imports are resolved into a real graph, then aggregated to directories."
            }
            surface="graph"
          >
            {result.moduleGraph ? <ModuleMap graph={result.moduleGraph} /> : null}
          </Act>

          <Act
            index="03"
            title="Sixteen signals, weighed."
            lede="Duplicated logic, dead code, comments that restate the line below them, tests that assert nothing. Each one contributes points, and the arithmetic is printed rather than summarised."
            surface="signals"
          >
            <SignalBreakdown score={authorship} persona="founder" />
          </Act>

          <Act
            index="04"
            title="A score, and what it means."
            lede={corpusComparison("authorship", authorship.score, "founder")}
            surface="score"
          >
            <ScoreScale
              dimension="authorship"
              score={authorship.score}
              caption="how much looks AI-written"
            />
          </Act>

          <Act
            index="05"
            title="What to fix first."
            lede="Every actionable finding across all three sections, ranked by severity then confidence — one entry per rule, so a single noisy check cannot fill the list."
            surface="priorities"
          >
            <Priorities
              persona="founder"
              priorities={report.priorities}
              totalActionable={
                report.findings.filter((f) => f.severity !== "info").length
              }
            />
          </Act>
        </>
      ) : (
        <Act
          index="02"
          title="Then it reads the code, not the vibes."
          lede="Imports resolved into a real module graph, sixteen weighted signals, a score with the arithmetic printed beside it, and a ranked shortlist of what to fix first. Paste a repository above to see it on your own code."
          surface="plain"
        />
      )}

      <Act
        index="06"
        title="And what it cannot see."
        lede="The limits are on the landing page rather than buried in the README, because a tool like this is only worth reading if it tells you where it stops."
        surface="plain"
      >
        <ActBlindSpots />
      </Act>

      {examples.length > 0 ? (
        <section className="coda">
          <h2>Or read one we prepared.</h2>
          <p className="act-lede">
            Real scans of real repositories, at permanent URLs.
          </p>
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
                      {authorshipBand(score).replace("-", " ")} to be
                      AI-generated
                    </em>
                  </span>
                </a>
              );
            })}
          </div>
        </section>
      ) : null}

      <section className="coda">
        <h2>Try it on something you wrote.</h2>
        <p className="act-lede">
          The interesting case is your own repository, where you already know
          the answer and can check ours against it.
        </p>
        <div className="coda-form">
          <StartScanForm />
        </div>
      </section>
    </main>
  );
}

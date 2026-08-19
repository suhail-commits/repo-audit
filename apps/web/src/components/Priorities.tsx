import { dimensionLabel, prioritiesCaveat, prioritiesTitle } from "@vibe/rules";
import type { NarratedFinding } from "@vibe/rules";
import type { Persona } from "@vibe/shared";

/**
 * The shortlist, above the sections.
 *
 * Three sections in a row is a lot to read before knowing whether any of it
 * matters, and nothing inside a section can rank against the other two: a
 * committed credential and a duplicated helper each sit at the top of their own
 * list, looking equally urgent. This is the only place the whole report is
 * ordered against itself.
 *
 * Every row links down to the section that owns it, so the shortlist stays a
 * table of contents rather than a fourth place findings are written out.
 */
export function Priorities({
  persona,
  priorities,
  totalActionable,
}: {
  persona: Persona;
  priorities: NarratedFinding[];
  /** Every actionable finding, so the caveat can say how many are not shown. */
  totalActionable: number;
}) {
  // Nothing to rank. Silence is right here: "no priorities" would be a heading
  // over an empty box, and the verdict above already says there is nothing to
  // do.
  if (priorities.length === 0) return null;

  return (
    <section className="priorities">
      <div className="section-head">
        <h3>{prioritiesTitle(persona)}</h3>
        <span className="meta">
          {prioritiesCaveat(priorities.length, totalActionable, persona)}
        </span>
      </div>

      <ol className="priority-list">
        {priorities.map((finding, i) => {
          const label = dimensionLabel(finding.dimension, persona).title;
          return (
            <li key={`${finding.ruleId}-${i}`}>
              {/*
                A same-page anchor now that every section is rendered. It used
                to be a full navigation carrying `focus`, because the section
                being linked to was not on the page yet.
              */}
              <a href={`#${finding.dimension}`}>
                <span className={`sev sev-${finding.severity}`}>
                  {finding.severity}
                </span>
                <span className="priority-title">{finding.title}</span>
                <span className="priority-section">{label}</span>
              </a>
            </li>
          );
        })}
      </ol>
    </section>
  );
}

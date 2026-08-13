import type { Dimension, Persona } from "@vibe/shared";

/**
 * What each section of the report is called, in the reader's own register.
 *
 * Same reasoning as `signal-labels.ts`: "Authorship" is the accurate name and
 * the one an engineer wants to see, but an owner reading about their own
 * project is better served by "Vibe check". The persona is already chosen, so
 * the section titles follow it rather than the report shipping a separate
 * plain-English mode.
 */

export interface DimensionLabel {
  /** Section heading. */
  title: string;
  /** One line under the heading saying what the section covers. */
  covers: string;
}

const LABELS: Record<Dimension, Record<Persona, DimensionLabel>> = {
  authorship: {
    founder: {
      title: "Vibe check",
      covers: "How much of this looks like it was written by AI",
    },
    engineer: {
      title: "Authorship",
      covers: "Weighted signals over commit history, artifacts and structure",
    },
    acquirer: {
      title: "Authorship",
      covers: "Likelihood the codebase was substantially AI-generated",
    },
  },
  security: {
    founder: {
      title: "Security",
      covers: "Exposed keys, unprotected pages, risky code",
    },
    engineer: {
      title: "Security",
      covers: "Secrets, route auth coverage, dangerous sinks",
    },
    acquirer: {
      title: "Security",
      covers: "Exposure that would need remediating before acquisition",
    },
  },
  health: {
    founder: {
      title: "Code health",
      covers: "Duplication, unused code, tests, and how it is put together",
    },
    engineer: {
      title: "Code health",
      covers: "Duplication, dead code, test quality, module structure",
    },
    acquirer: {
      title: "Code health",
      covers: "What it will cost to keep changing this codebase",
    },
  },
};

export function dimensionLabel(
  dimension: Dimension,
  persona: Persona,
): DimensionLabel {
  return LABELS[dimension][persona];
}

/**
 * Heading for the directory ranking, per dimension and persona.
 *
 * Phrased as *where the signs are*, never as a verdict about the folder. The
 * ranking is relative and built from a subset of the checks, so wording that
 * implied a folder had been scored would be claiming more than was measured.
 */
const HOTSPOT_TITLES: Record<Dimension, Record<Persona, string>> = {
  authorship: {
    founder: "Where the signs are strongest",
    engineer: "Signal concentration by directory",
    acquirer: "Where generated code concentrates",
  },
  health: {
    founder: "Where the problems concentrate",
    engineer: "Defect concentration by directory",
    acquirer: "Where remediation would focus",
  },
  security: {
    founder: "Where the risk concentrates",
    engineer: "Exposure concentration by directory",
    acquirer: "Where exposure concentrates",
  },
};

export function hotspotTitle(dimension: Dimension, persona: Persona): string {
  return HOTSPOT_TITLES[dimension][persona];
}

/**
 * The opening line for a dimension that has no analyzer.
 *
 * The report shows one dimension at a time, so the page headline has to come
 * from *that* dimension. Falling back to the authorship headline printed
 * "Authorship 14/100 — unlikely to be AI-generated" at the top of the Security
 * page, which is a confident answer to a question nobody asked and no answer at
 * all to the one they did.
 */
export function notAnalysedHeadline(
  dimension: Dimension,
  persona: Persona,
): string {
  const title = LABELS[dimension][persona].title;
  if (persona === "engineer") return `${title}: no analyzer registered.`;
  return `We haven't built the ${title.toLowerCase()} checks yet.`;
}

/**
 * Heading for the cross-section shortlist.
 *
 * Phrased as an *ordering* of what was found, never as an instruction. "Fix
 * these" would assert that each item is a defect worth a developer's afternoon,
 * which is a judgement about someone else's priorities that nothing here
 * measured. We ranked what we found; the reader decides what to do with it.
 */
export function prioritiesTitle(persona: Persona): string {
  if (persona === "engineer") return "Ranked by severity";
  if (persona === "acquirer") return "Most material findings";
  return "Where we'd look first";
}

/**
 * The line under that heading, naming the rule the ordering used.
 *
 * `total` is every actionable finding, `shown` the head of the list. Saying how
 * many were left out matters: a shortlist that silently truncates reads as the
 * complete set, which is the same mistake as a capped scan reporting "covered
 * everything".
 */
export function prioritiesCaveat(
  shown: number,
  total: number,
  persona: Persona,
): string {
  const rule =
    persona === "engineer"
      ? "Severity, then confidence."
      : "Most serious first, and where we are surest.";
  if (total <= shown) return rule;
  return `${rule} ${total - shown} more below.`;
}

/**
 * The caveat under the ranking.
 *
 * `count` is computed from the signals that actually contributed, not written
 * as a constant: `write-once-files` is unavailable on any scan sourced from the
 * GitHub API, so the same repository legitimately ranks on fewer checks there
 * than it does from a local checkout.
 */
export function hotspotCaveat(count: number, persona: Persona): string {
  const one = count === 1;
  if (persona === "engineer") {
    return (
      `Ordering only, from the ${count} ${one ? "check" : "checks"} that ` +
      `attribute per file. Not a per-directory score.`
    );
  }
  return (
    `Based on the ${count} ${one ? "check" : "checks"} that ${one ? "works" : "work"} ` +
    `file by file. It shows the order, not a score for each folder.`
  );
}

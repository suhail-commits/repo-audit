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

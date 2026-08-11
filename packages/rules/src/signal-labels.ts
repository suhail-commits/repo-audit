import type { Persona } from "@vibe/shared";

/**
 * What each signal is called, and what it means, in the reader's own register.
 *
 * The breakdown used to derive names mechanically from the signal id, which
 * produced "Agent trailers", "Write once files" and "Tautological tests" — terms
 * that mean something to us and nothing to someone reading a report about their
 * own repository.
 *
 * The persona machinery already exists to solve exactly this, so labels follow
 * the persona rather than adding a separate "simple mode": the owner sees plain
 * English, the engineer sees the signal id they would grep for.
 */

export interface SignalLabel {
  /** Short name shown beside the bar. */
  label: string;
  /** One line explaining what was measured. */
  explains: string;
}

interface LabelEntry {
  /** Plain English — used for the owner, and as the base for the buyer. */
  plain: SignalLabel;
  /** Technical framing for the engineer. */
  technical?: Partial<SignalLabel>;
}

const LABELS: Record<string, LabelEntry> = {
  "agent-trailers": {
    plain: {
      label: "AI credited in commits",
      explains:
        "Commit messages that name an AI assistant as a co-author. The project's own history saying so.",
    },
    technical: { label: "agent-trailers" },
  },
  "builder-platform": {
    plain: {
      label: "Built by an app generator",
      explains:
        "Leftover files from no-code builders like Lovable, Bolt or v0 that generate a whole app at once.",
    },
    technical: { label: "builder-platform" },
  },
  "agent-tooling": {
    plain: {
      label: "AI assistant set up",
      explains:
        "Configuration written for a coding assistant — CLAUDE.md, .cursorrules and similar — committed to the repo.",
    },
    technical: { label: "agent-tooling" },
  },
  "commit-size": {
    plain: {
      label: "Size of each commit",
      explains:
        "How much changes at once. Very large commits suggest code arriving in bulk rather than being written by hand.",
    },
    technical: { label: "commit-size" },
  },
  "commit-messages": {
    plain: {
      label: "Commit message quality",
      explains:
        "Messages that say nothing — “fix”, “wip”, “update” — or the same message used repeatedly.",
    },
    technical: { label: "commit-messages" },
  },
  "build-velocity": {
    plain: {
      label: "How fast it was written",
      explains:
        "Lines of code per contributor per active day. Far beyond a human pace is a strong tell.",
    },
    technical: { label: "build-velocity" },
  },
  "write-once-files": {
    plain: {
      label: "Files never revisited",
      explains:
        "Files created in one commit and never touched again — code that was emitted rather than iterated on.",
    },
    technical: { label: "write-once-files" },
  },
  "duplicate-logic": {
    plain: {
      label: "The same code written twice",
      explains:
        "Functions with identical structure under different names, which happens when a tool forgets it already wrote one.",
    },
    technical: { label: "duplicate-logic" },
  },
  "convention-drift": {
    plain: {
      label: "Inconsistent style between files",
      explains:
        "Each file internally tidy but disagreeing with its neighbours — the shape of code written one session at a time.",
    },
    technical: { label: "convention-drift" },
  },
  "unused-dependencies": {
    plain: {
      label: "Packages never used",
      explains:
        "Libraries installed but never imported, usually left behind by an approach that was abandoned.",
    },
    technical: { label: "unused-dependencies" },
  },
  "orphan-files": {
    plain: {
      label: "Files nothing links to",
      explains: "Source files no other file imports and no framework loads.",
    },
    technical: { label: "orphan-files" },
  },
  "overlapping-utils": {
    plain: {
      label: "Several catch-all modules",
      explains:
        "Multiple grab-bag files — utils, helpers, lib — solving overlapping problems.",
    },
    technical: { label: "overlapping-utils" },
  },
  "obvious-comments": {
    plain: {
      label: "Comments restating the code",
      explains:
        "Comments that describe what the next line plainly says, rather than why it is there.",
    },
    technical: { label: "obvious-comments" },
  },
  "tautological-tests": {
    plain: {
      label: "Tests that check nothing",
      explains:
        "Tests with no assertions, or that only confirm a mock they just configured was called.",
    },
    technical: { label: "tautological-tests" },
  },
  "test-coverage": {
    plain: {
      label: "How much has tests",
      explains:
        "Test files measured against source files. Counted by file, not by line — we never run the suite.",
    },
    technical: { label: "test-coverage" },
  },
};

/**
 * Falls back to a readable form of the id rather than throwing, so a signal
 * added without a label degrades to the old behaviour instead of breaking the
 * report. `signal-labels.test.ts` fails when that happens, so the gap surfaces
 * in CI rather than in front of a reader.
 */
export function signalLabel(id: string, persona: Persona): SignalLabel {
  const entry = LABELS[id];
  if (!entry) {
    const words = id.replace(/-/g, " ");
    return {
      label: words.charAt(0).toUpperCase() + words.slice(1),
      explains: "",
    };
  }

  if (persona === "engineer") {
    return { ...entry.plain, ...entry.technical };
  }
  return entry.plain;
}

/** Exposed so a test can assert every emitted signal has a real label. */
export function labelledSignalIds(): string[] {
  return Object.keys(LABELS).sort();
}

import { buildContext, analyzeAuthorship, analyzeHealth } from "@vibe/engine";
import { createFixtureRepo } from "@vibe/engine/testing";
import {
  PERSONAS,
  type DimensionScore,
  type Finding,
  type ScanResult,
  type Signal,
} from "@vibe/shared";
import { afterEach, describe, expect, it } from "vitest";

import { prioritiesCaveat } from "./dimension-labels";
import { TemplateNarrator } from "./narrator";
import { signalLabel, labelledSignalIds } from "./signal-labels";
import { FALLBACK_TEMPLATE, templateFor, templatedRuleIds } from "./templates";

const narrator = new TemplateNarrator();

let cleanup: (() => void) | undefined;
afterEach(() => {
  cleanup?.();
  cleanup = undefined;
});

const VIBE_FILES: Record<string, string> = {
  "package.json": JSON.stringify({
    name: "vite_react_shadcn_ts",
    dependencies: {
      next: "^15.0.0",
      react: "^19.0.0",
      "lovable-tagger": "^1.0.0",
      axios: "^1.0.0",
      lodash: "^4.0.0",
      moment: "^2.0.0",
      uuid: "^9.0.0",
      clsx: "^2.0.0",
      "date-fns": "^3.0.0",
    },
  }),
  "src/utils.ts": dupHelper("formatDate", "-"),
  "src/helpers.ts": dupHelper("prettyDate", "/"),
  "src/lib.ts": dupHelper("displayDate", "."),
};

function dupHelper(name: string, sep: string): string {
  return `export const ${name} = (value) => {
  const parsed = new Date(value);
  const year = parsed.getFullYear();
  const month = parsed.getMonth() + 1;
  const day = parsed.getDate();
  return year + "${sep}" + month + "${sep}" + day;
};
`;
}

async function findingsFor(
  files: Record<string, string>,
  withGit: boolean,
): Promise<Finding[]> {
  const repo = withGit
    ? createFixtureRepo({
        commits: [
          {
            message: "feat: build it\n\nCo-Authored-By: Claude <noreply@anthropic.com>",
            files,
          },
        ],
      })
    : createFixtureRepo({ files, withoutGit: true });
  cleanup = repo.cleanup;

  const ctx = await buildContext(repo.rootPath);
  return analyzeAuthorship(ctx).findings;
}

describe("template coverage", () => {
  it("has a hand-written template for every rule the engine emits", async () => {
    const findings = await findingsFor(VIBE_FILES, true);
    const emitted = [...new Set(findings.map((f) => f.ruleId))];

    expect(emitted.length).toBeGreaterThan(0);

    // The fallback exists for vendored scanners that emit hundreds of rule IDs.
    // Rules we author ourselves should never quietly land on it.
    const usingFallback = emitted.filter(
      (ruleId) => templateFor(ruleId) === FALLBACK_TEMPLATE,
    );
    expect(
      usingFallback,
      `these engine rules have no template: ${usingFallback.join(", ")}`,
    ).toEqual([]);
  });

  it("has a plain-language label for every signal the engine emits", async () => {
    /*
     * Same shape as the template-coverage test above, and for the same reason:
     * without it a new signal ships showing its raw id — "write-once-files" —
     * to someone reading a report about their own repository.
     */
    const repo = createFixtureRepo({
      commits: [{ message: "feat: build it", files: VIBE_FILES }],
    });
    cleanup = repo.cleanup;

    const ctx = await buildContext(repo.rootPath);
    const authorship = analyzeAuthorship(ctx);
    /*
     * Every dimension that carries a score, not just authorship. Checking one
     * of them would have passed while `test-coverage` — a health-only signal —
     * rendered as "Test coverage" from the id-humanising fallback.
     */
    const emitted = [
      ...authorship.score.signals,
      ...analyzeHealth(ctx, authorship.score.signals).score.signals,
    ].map((s) => s.id);
    expect(emitted.length).toBeGreaterThan(0);

    const labelled = new Set(labelledSignalIds());
    const missing = emitted.filter((id) => !labelled.has(id));
    expect(
      missing,
      `these signals have no label: ${missing.join(", ")}`,
    ).toEqual([]);
  });

  it("gives the owner plain words and the engineer the signal id", () => {
    expect(signalLabel("write-once-files", "founder").label).toBe(
      "Files never revisited",
    );
    expect(signalLabel("write-once-files", "engineer").label).toBe(
      "write-once-files",
    );
    // The explanation is shared; only the name changes register.
    expect(signalLabel("write-once-files", "engineer").explains).toBe(
      signalLabel("write-once-files", "founder").explains,
    );
  });

  it("lists its templated rules", () => {
    expect(templatedRuleIds()).toContain("duplicate-function");
  });
});

describe("persona voice", () => {
  const finding: Finding = {
    ruleId: "duplicate-function",
    dimension: "authorship",
    severity: "medium",
    confidence: "high",
    source: "builtin",
    title: "duplicates",
    locations: [
      { file: "src/utils.ts", line: 1 },
      { file: "src/helpers.ts", line: 1 },
    ],
    data: {
      copies: 3,
      names: ["formatDate", "prettyDate", "displayDate"],
      files: ["src/utils.ts", "src/helpers.ts", "src/lib.ts"],
    },
    estimatedFixMinutes: 30,
  };

  it("renders the same finding differently per persona", () => {
    const founder = narrator.finding(finding, "founder");
    const engineer = narrator.finding(finding, "engineer");
    const acquirer = narrator.finding(finding, "acquirer");

    expect(founder.body).not.toBe(engineer.body);
    expect(engineer.body).not.toBe(acquirer.body);

    // Founder prose avoids jargon and explains the consequence.
    expect(founder.body).toContain("same logic");
    expect(founder.detail.join(" ")).toMatch(/bug|fix/i);

    // Engineer prose names the technique and points at files.
    expect(engineer.body).toMatch(/clone/i);

    // Acquirer prose quantifies effort.
    expect(acquirer.detail.join(" ")).toMatch(/effort/i);
  });

  it("is deterministic — the same finding always renders identically", () => {
    const a = narrator.finding(finding, "founder");
    const b = narrator.finding(finding, "founder");
    expect(a).toEqual(b);
  });

  it("fills every placeholder in the licence-mismatch prose", () => {
    /*
     * The template reads five keys out of `data`. A typo in any of them prints
     * the string "undefined" into the report and nothing fails — the template
     * coverage test only proves a template exists, not that it was given what
     * it asks for. This is the one finding whose prose no fixture produces.
     */
    const finding: Finding = {
      ruleId: "license-mismatch",
      dimension: "security",
      severity: "medium",
      confidence: "high",
      source: "builtin",
      title: "The licence file and the manifest disagree",
      locations: [{ file: "LICENSE" }, { file: "package.json" }],
      data: {
        declared: "MIT",
        identified: "AGPL-3.0",
        declaredIn: "package.json",
        licenseFile: "LICENSE",
      },
    };

    for (const persona of PERSONAS) {
      const rendered = narrator.finding(finding, persona);
      const text = [rendered.title, rendered.body, ...rendered.detail].join(" ");
      expect(text, persona).not.toContain("undefined");
      expect(text, persona).toContain("AGPL-3.0");
      expect(text, persona).toContain("MIT");
    }
  });

  it("falls back gracefully for an unknown rule", () => {
    const unknown: Finding = {
      ruleId: "semgrep.javascript.express.security.audit.xss",
      dimension: "security",
      severity: "high",
      confidence: "medium",
      source: "semgrep",
      title: "Untrusted input reaches res.send()",
      locations: [{ file: "server/index.js", line: 42 }],
      data: {},
    };

    const engineer = narrator.finding(unknown, "engineer");
    expect(engineer.title).toBe("Untrusted input reaches res.send()");
    expect(engineer.detail).toContain("server/index.js:42");

    const founder = narrator.finding(unknown, "founder");
    expect(founder.body).toContain("high");
  });
});

function signalStub(id: string, value: number) {
  return { id, value, weight: 2, available: true, evidence: [] };
}

describe("score narration", () => {
  function scanResultWith(scores: ScanResult["scores"]): ScanResult {
    return {
      schemaVersion: 1,
      repo: {
        kind: "zip",
        name: "demo",
        rootPath: "/tmp/demo",
        hasGitHistory: false,
        fileCount: 20,
        sourceFileCount: 14,
        totalLoc: 1200,
        frameworks: ["next", "supabase"],
        languages: [
          {
            language: "typescript",
            label: "TypeScript",
            tier: "full" as const,
            files: 14,
            sloc: 1200,
            share: 1,
          },
        ],
        analysisTier: "full" as const,
      },
      scores,
      findings: [],
      metrics: [],
      analysedDimensions: ["authorship" as const, "health" as const],
      durationMs: 120,
      warnings: [],
    };
  }

  it("states plainly that missing evidence does not mean clean code", () => {
    const result = scanResultWith([
      {
        dimension: "authorship",
        score: 61,
        confidence: "medium",
        signals: [],
        unavailable: ["no git history in the uploaded source"],
      },
    ]);

    const report = narrator.report(result, "founder");
    /*
     * The single most important honesty guarantee in the whole report: a low
     * score caused by missing evidence must never read as a clean bill of
     * health. Asserted on meaning rather than exact phrasing, so rewording the
     * copy does not break the test while dropping the guarantee would.
     */
    const caveats = report.scores[0]!.caveats.join(" ");
    const lower = caveats.toLowerCase();
    expect(lower).toContain("not");
    expect(lower).toContain("clean");
    expect(caveats).toMatch(/no git history in the uploaded source/i);
  });

  it("gives the founder a verdict sentence and the engineer a measurement", () => {
    const result = scanResultWith([
      {
        dimension: "authorship",
        score: 82,
        confidence: "certain",
        signals: [],
        unavailable: [],
      },
    ]);

    expect(narrator.report(result, "founder").headline).toBe(
      "This app was almost certainly built with AI coding tools.",
    );
    expect(narrator.report(result, "engineer").headline).toMatch(
      /Authorship 82\/100.*near-certain.*certain confidence/,
    );
  });

  it("never says hand-written when the repo carries AI tooling evidence", () => {
    /*
     * The report used to headline "this mostly looks like hand-written code"
     * directly above "Claude Code: CLAUDE.md present". A low score means the
     * *code* shows few of the usual patterns — not that no AI was involved.
     */
    const result = scanResultWith([
      {
        dimension: "authorship",
        score: 15,
        confidence: "high",
        signals: [
          {
            id: "agent-tooling",
            value: 1,
            weight: 3,
            available: true,
            evidence: ["Claude Code: `CLAUDE.md` present"],
          },
          {
            id: "duplicate-logic",
            value: 0,
            weight: 2.5,
            available: true,
            evidence: [],
          },
        ],
        unavailable: [],
      },
    ]);

    const headline = narrator.report(result, "founder").headline;
    expect(headline).not.toMatch(/hand-written/i);
    expect(headline).toMatch(/AI tools were used/i);
  });

  it("still says hand-written when nothing points at AI tooling", () => {
    const result = scanResultWith([
      {
        dimension: "authorship",
        score: 4,
        confidence: "high",
        signals: [
          {
            id: "agent-tooling",
            value: 0,
            weight: 3,
            available: true,
            evidence: [],
          },
        ],
        unavailable: [],
      },
    ]);

    expect(narrator.report(result, "founder").headline).toMatch(/hand-written/i);
  });

  it("only cites evidence from signals that actually fired", () => {
    const result = scanResultWith([
      {
        dimension: "authorship",
        score: 40,
        confidence: "high",
        signals: [
          {
            id: "fired",
            value: 0.8,
            weight: 2,
            available: true,
            evidence: ["8 of 10 functions are duplicates"],
          },
          {
            id: "quiet",
            value: 0.0,
            weight: 2,
            available: true,
            evidence: ["this should not appear"],
          },
          {
            id: "missing",
            value: 0,
            weight: 2,
            available: false,
            evidence: ["nor this"],
            unavailableReason: "no git history",
          },
        ],
        unavailable: ["no git history"],
      },
    ]);

    const evidence = narrator.report(result, "engineer").scores[0]!.evidence;
    expect(evidence).toEqual(["8 of 10 functions are duplicates."]);
  });

  it("tells a clean repo there is nothing to do, in each register", () => {
    const result = scanResultWith([
      {
        dimension: "authorship",
        score: 4,
        confidence: "high",
        signals: [
          signalStub("agent-tooling", 0),
          signalStub("duplicate-logic", 0),
        ],
        unavailable: [],
      },
    ]);

    expect(narrator.report(result, "founder").verdict).toMatch(
      /nothing here needs your attention/i,
    );
    expect(narrator.report(result, "engineer").verdict).toMatch(/no actionable findings/i);
    expect(narrator.report(result, "acquirer").verdict).toMatch(
      /no remediation was identified/i,
    );
  });

  it("says the reading is provisional when most checks could not run", () => {
    const result = scanResultWith([
      {
        dimension: "authorship",
        score: 10,
        confidence: "low",
        signals: [
          signalStub("agent-tooling", 0),
          { ...signalStub("commit-size", 0), available: false, unavailableReason: "no history" },
          { ...signalStub("commit-messages", 0), available: false, unavailableReason: "no history" },
          { ...signalStub("build-velocity", 0), available: false, unavailableReason: "no history" },
        ],
        unavailable: ["no history"],
      },
    ]);

    // 1 of 4 measured — the verdict must not read as a settled answer.
    expect(narrator.report(result, "founder").verdict).toMatch(/first impression/i);
    expect(narrator.report(result, "engineer").verdict).toMatch(/coverage is thin/i);
    expect(narrator.report(result, "acquirer").verdict).toMatch(/indicative/i);
  });

  it("counts only actionable findings, not informational ones", () => {
    const result = scanResultWith([
      {
        dimension: "authorship",
        score: 4,
        confidence: "high",
        signals: [signalStub("agent-tooling", 1)],
        unavailable: [],
      },
    ]);
    // An "AI tooling is configured" note is information, not a task.
    result.findings = [
      {
        ruleId: "ai-agent-tooling",
        dimension: "authorship",
        severity: "info",
        confidence: "certain",
        source: "builtin",
        title: "Configured for AI-assisted development",
        locations: [],
        data: { tools: ["Claude Code"], evidence: ["`CLAUDE.md` present"] },
      },
    ];

    // An informational note is context, not a task, so the reader is told there
    // is nothing to act on.
    expect(narrator.report(result, "founder").verdict).toMatch(
      /nothing here needs your attention/i,
    );
  });

  it("orders findings worst-first", () => {
    const mk = (id: string, severity: Finding["severity"]): Finding => ({
      ruleId: id,
      dimension: "authorship",
      severity,
      confidence: "high",
      source: "builtin",
      title: id,
      locations: [],
      data: {},
    });

    const result = scanResultWith([]);
    result.findings = [mk("a", "low"), mk("b", "critical"), mk("c", "medium")];

    expect(
      narrator.report(result, "engineer").findings.map((f) => f.severity),
    ).toEqual(["critical", "medium", "low"]);
  });
});

/**
 * The shortlist exists because the report shows one dimension at a time, so a
 * reader looking at Code health has no way to learn that the worst thing in the
 * repository is two tabs away.
 */
describe("what to look at first", () => {
  const mk = (
    id: string,
    severity: Finding["severity"],
    over: Partial<Finding> = {},
  ): Finding => ({
    ruleId: id,
    dimension: "authorship",
    severity,
    confidence: "high",
    source: "builtin",
    title: id,
    locations: [],
    data: {},
    ...over,
  });

  function resultWith(findings: Finding[]): ScanResult {
    return {
      schemaVersion: 1,
      repo: {
        kind: "zip",
        name: "demo",
        rootPath: "/tmp/demo",
        hasGitHistory: false,
        fileCount: 20,
        sourceFileCount: 14,
        totalLoc: 1200,
        frameworks: [],
        languages: [],
        analysisTier: "full" as const,
      },
      scores: [],
      findings,
      metrics: [],
      analysedDimensions: ["authorship" as const],
      durationMs: 10,
      warnings: [],
    };
  }

  it("crosses dimensions — the worst thing wins whichever section it is in", () => {
    const report = narrator.report(
      resultWith([
        mk("dup", "medium", { dimension: "health" }),
        mk("key", "critical", { dimension: "security" }),
        mk("dead", "low", { dimension: "health" }),
      ]),
      "founder",
    );

    expect(report.priorities.map((f) => f.ruleId)).toEqual([
      "key",
      "dup",
      "dead",
    ]);
    expect(report.priorities[0]!.dimension).toBe("security");
  });

  it("breaks a severity tie on confidence, not on how widespread it is", () => {
    /*
     * A guess that appears in thirty files must not outrank a fact that appears
     * in one. Counting locations first did exactly that, which is why the
     * comparator gained a confidence term.
     */
    const spread = mk("guess", "medium", {
      confidence: "low",
      locations: Array.from({ length: 30 }, (_, i) => ({ file: `f${i}.ts` })),
    });
    const sure = mk("fact", "medium", { confidence: "certain" });

    const report = narrator.report(resultWith([spread, sure]), "engineer");
    expect(report.priorities.map((f) => f.ruleId)).toEqual(["fact", "guess"]);
  });

  it("leaves out info findings — they are context, not tasks", () => {
    const report = narrator.report(
      resultWith([
        mk("tooling", "info", { confidence: "certain" }),
        mk("dup", "low"),
      ]),
      "founder",
    );

    expect(report.priorities.map((f) => f.ruleId)).toEqual(["dup"]);
  });

  it("is empty on a clean repo rather than padded with information", () => {
    const report = narrator.report(
      resultWith([mk("tooling", "info", { confidence: "certain" })]),
      "founder",
    );
    expect(report.priorities).toEqual([]);
  });

  it("caps the list and says how many were left out", () => {
    const many = Array.from({ length: 9 }, (_, i) => mk(`r${i}`, "medium"));
    const report = narrator.report(resultWith(many), "founder");

    expect(report.priorities).toHaveLength(5);
    // The full set stays reachable below; only the shortlist is capped.
    expect(report.findings).toHaveLength(9);
    expect(prioritiesCaveat(5, 9, "founder")).toMatch(/4 more below/);
  });

  it("shows each rule once, so one noisy rule cannot fill the list", () => {
    /*
     * Clone detection emits one finding per family. On this repository four of
     * the five slots were "near-identical copies of the same function" — the
     * reader learns one thing, five times, while four different problems are
     * pushed off the list.
     */
    const report = narrator.report(
      resultWith([
        mk("dup", "medium"),
        mk("dup", "medium"),
        mk("dup", "medium"),
        mk("dup", "medium"),
        mk("dead", "low"),
        mk("untested", "low"),
      ]),
      "founder",
    );

    expect(report.priorities.map((f) => f.ruleId)).toEqual([
      "dup",
      "dead",
      "untested",
    ]);
    // Nothing is hidden — the section below still carries every one of them.
    expect(report.findings).toHaveLength(6);
  });

  it("keeps the worst instance when a rule fires more than once", () => {
    const report = narrator.report(
      resultWith([
        mk("secret", "low"),
        mk("secret", "critical"),
        mk("secret", "medium"),
      ]),
      "engineer",
    );

    expect(report.priorities).toHaveLength(1);
    expect(report.priorities[0]!.severity).toBe("critical");
  });

  it("does not truncate silently when everything fits", () => {
    expect(prioritiesCaveat(3, 3, "founder")).not.toMatch(/more below/);
  });

  it("orders the shortlist identically to the section list", () => {
    // Same objects, not merely equal ones — a priority and its entry in the
    // section must never drift apart.
    const report = narrator.report(
      resultWith([mk("a", "low"), mk("b", "critical"), mk("c", "high")]),
      "engineer",
    );
    expect(report.priorities[0]).toBe(report.findings[0]);
  });
});

/**
 * The security headline is the one that must not follow its own number.
 *
 * Its signals are presence-shaped, so a single committed credential saturates
 * one check out of five and lands the dimension in the twenties. A band word
 * taken from twenty-something would read "minor issues" directly above a live
 * key. These pin the behaviour, because the first implementation simply fell
 * through to `${dimension}: ${score}/100` and rendered "security: 21/100".
 */
describe("security headline", () => {
  const signal = (id: string, available: boolean): Signal =>
    available
      ? { id, value: 0, weight: 1, available: true, evidence: [] }
      : {
          id,
          value: 0,
          weight: 1,
          available: false,
          evidence: [],
          unavailableReason: `${id} had nothing to judge`,
        };

  const score = (value: number, availableCount: number): DimensionScore => ({
    dimension: "security",
    score: value,
    confidence: "high",
    signals: [
      signal("a", availableCount > 0),
      signal("b", availableCount > 1),
      signal("c", availableCount > 2),
    ],
    unavailable: [],
    hotspots: [],
  });

  const finding = (severity: Finding["severity"], title: string): Finding => ({
    ruleId: "hardcoded-secret",
    dimension: "security",
    severity,
    confidence: "certain",
    source: "builtin",
    title,
    locations: [],
    data: {},
  });

  it("leads with the worst finding, not the score", () => {
    const narrated = narrator.score(score(8, 3), "founder", [
      finding("low", "Something small"),
      finding("critical", "AWS access key ID committed to the repository"),
    ]);

    expect(narrated.headline).toContain("needs fixing today");
    expect(narrated.headline).toContain("aws access key id");
    // The number is still 8; it must not be what sets the register.
    expect(narrated.headline).not.toContain("8/100");
  });

  it("names the severity and count for the engineer", () => {
    const narrated = narrator.score(score(21, 3), "engineer", [
      finding("medium", "A route does not check the caller"),
    ]);

    expect(narrated.headline).toBe(
      "Security 21/100 — 1 finding, worst medium (3/3 checks ran)",
    );
  });

  it("ignores info findings when choosing the register", () => {
    const narrated = narrator.score(score(0, 3), "founder", [
      { ...finding("info", "Context only"), severity: "info" },
    ]);

    expect(narrated.headline).toBe("We did not find anything exposed.");
  });

  /**
   * "Nothing found" may only sound like "nothing there" when everything ran.
   * An unreachable vulnerability database is not a clean bill of health.
   */
  it("will not say clean when a check could not run", () => {
    const narrated = narrator.score(score(0, 2), "founder", []);

    expect(narrated.headline).toContain("1 of the 3 checks could not run");
  });

  it("says so plainly when every check ran and found nothing", () => {
    const narrated = narrator.score(score(0, 3), "acquirer", []);

    expect(narrated.headline).toBe("No exposure found across all checks.");
  });
});

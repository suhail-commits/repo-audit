import { buildContext, analyzeProvenance } from "@vibe/engine";
import { createFixtureRepo } from "@vibe/engine/testing";
import type { Finding, ScanResult } from "@vibe/shared";
import { afterEach, describe, expect, it } from "vitest";

import { TemplateNarrator } from "./narrator";
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
  return analyzeProvenance(ctx).findings;
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

  it("lists its templated rules", () => {
    expect(templatedRuleIds()).toContain("duplicate-function");
  });
});

describe("persona voice", () => {
  const finding: Finding = {
    ruleId: "duplicate-function",
    dimension: "provenance",
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
      architecture: {
        verdict: "insufficient-evidence",
        modularity: 0,
        moduleCount: 0,
        serviceCount: 0,
        evidence: [],
      },
      durationMs: 120,
      warnings: [],
    };
  }

  it("states plainly that missing evidence does not mean clean code", () => {
    const result = scanResultWith([
      {
        dimension: "provenance",
        score: 61,
        confidence: "medium",
        signals: [],
        unavailable: ["no git history in the uploaded source"],
      },
    ]);

    const report = narrator.report(result, "founder");
    // The single most important honesty guarantee in the whole report.
    expect(report.scores[0]!.caveats.join(" ")).toMatch(/not that the code is cleaner/i);
  });

  it("gives the founder a verdict sentence and the engineer a measurement", () => {
    const result = scanResultWith([
      {
        dimension: "provenance",
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
      /Provenance 82\/100.*near-certain.*certain confidence/,
    );
  });

  it("only cites evidence from signals that actually fired", () => {
    const result = scanResultWith([
      {
        dimension: "provenance",
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

  it("orders findings worst-first", () => {
    const mk = (id: string, severity: Finding["severity"]): Finding => ({
      ruleId: id,
      dimension: "provenance",
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

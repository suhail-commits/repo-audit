import { describe, expect, it } from "vitest";

import type { DimensionScore, ScanResult, Signal } from "@vibe/shared";

import { run } from "./main";
import { renderReport } from "./render/report";
import { renderSignals } from "./render/signals";

/*
 * Neither CLI this replaces had a single test, and neither could have: both
 * called `main()` on import and exported nothing, so there was no seam. The
 * renderers here are pure `ScanResult` → string, and `run()` returns its output
 * instead of printing it, which is the whole reason any of this is testable.
 */

function signal(over: Partial<Signal> & { id: string }): Signal {
  return {
    value: 0.5,
    weight: 2,
    available: true,
    evidence: [],
    ...over,
  };
}

function score(over: Partial<DimensionScore> = {}): DimensionScore {
  return {
    dimension: "authorship",
    score: 40,
    confidence: "high",
    unavailable: [],
    signals: [
      signal({ id: "agent-tooling", value: 1, weight: 3, evidence: ["CLAUDE.md present"] }),
      signal({
        id: "build-velocity",
        available: false,
        value: 0,
        weight: 2,
        unavailableReason: "only 1 active day — a rate needs a longer span",
      }),
    ],
    ...over,
  };
}

function result(over: Partial<ScanResult> = {}): ScanResult {
  return {
    schemaVersion: 1,
    repo: {
      kind: "zip",
      name: "demo",
      rootPath: "/tmp/demo",
      hasGitHistory: true,
      fileCount: 20,
      sourceFileCount: 12,
      totalLoc: 900,
      frameworks: ["next"],
      languages: [
        { language: "typescript", label: "TypeScript", tier: "full", files: 12, sloc: 900, share: 1 },
      ],
      analysisTier: "full",
      headSha: "abcdef1234567890",
    },
    scores: [score(), score({ dimension: "security", score: 0 }), score({ dimension: "health", score: 10 })],
    findings: [],
    metrics: [],
    analysedDimensions: ["authorship", "security", "health"],
    durationMs: 123,
    warnings: [],
    ...over,
  };
}

describe("renderReport", () => {
  it("draws the band scale with every band and its threshold", () => {
    // The first attempt positioned band labels under the track and silently
    // dropped whichever collided — on security that hid the *first* band, so
    // the scale appeared to start at "some".
    const out = renderReport(result(), "founder");
    for (const band of ["unlikely", "possible", "likely", "near certain"]) {
      expect(out).toContain(band);
    }
    for (const band of ["nothing found", "some", "several", "widespread"]) {
      expect(out).toContain(band);
    }
  });

  it("states coverage as available evidence, not as a failure", () => {
    const out = renderReport(result(), "founder");
    expect(out).toContain("Based on 1 of 2 checks");
    expect(out).toContain("evidence this repository doesn't have");
  });

  it("names the revision that was measured", () => {
    // Without it a reader cannot account for the same project reading
    // differently from a local checkout than through the API.
    expect(renderReport(result(), "founder")).toContain("abcdef1");
  });

  it("says no code was executed", () => {
    expect(renderReport(result(), "founder")).toContain("No code from this repository was executed");
  });
});

describe("renderSignals", () => {
  it("shows an unavailable signal as not measured, never as a zero bar", () => {
    // A zero bar reads as "measured, found nothing", which inverts the
    // invariant that a missing signal lowers confidence rather than the score.
    const out = renderSignals(result(), "engineer");
    expect(out).toContain("not measured");
    expect(out).toContain("only 1 active day");
  });

  it("prints the contribution in points, so the rows sum to the score", () => {
    // The old output printed value and weight and left the reader to multiply,
    // which meant checking the arithmetic required doing the arithmetic.
    const out = renderSignals(result(), "engineer");
    expect(out).toMatch(/\+\d+\.\d/);
    expect(out).toContain("→ score");
  });
});

describe("run", () => {
  it("prints help without scanning anything", async () => {
    const out = await run(["--help"]);
    expect(out.exitCode).toBe(0);
    expect(out.stdout).toContain("USAGE");
  });

  it("rejects an unknown flag rather than ignoring it", async () => {
    // Both CLIs this replaces silently ignored unknown flags — the same shape
    // as every "a parser that quietly produces nothing looks like a clean
    // result" bug in this project.
    const out = await run([".", "--definitely-not-a-flag"]);
    expect(out.exitCode).toBe(2);
    expect(out.stderr).toContain("--definitely-not-a-flag");
  });

  it("rejects an unknown persona rather than falling back to founder", async () => {
    // The old `report` CLI produced a report for the wrong reader on a typo
    // and said nothing about it.
    const out = await run([".", "--persona", "ceo"]);
    expect(out.exitCode).toBe(2);
    expect(out.stderr).toContain("Unknown persona");
    expect(out.stderr).toContain("founder");
  });

  it("asks for a target rather than guessing one", async () => {
    const out = await run([]);
    expect(out.exitCode).toBe(2);
    expect(out.stderr).toContain("Nothing to scan");
  });

  it("refuses more than one repository", async () => {
    const out = await run([".", "../elsewhere"]);
    expect(out.exitCode).toBe(2);
    expect(out.stderr).toContain("Expected one repository");
  });

  it("reports which grammars actually loaded", async () => {
    /*
     * The first version of this test asserted the exit code and that "python",
     * "go" and "rust" appeared in the output — and **it could not fail**, because
     * those words appear in the `FAILED` lines too. A completely broken install
     * passed it.
     *
     * Asserting the absence of `FAILED` is the whole point: it is the only part
     * of the output that distinguishes a working install from a dead one.
     */
    const out = await run(["--selftest"]);
    expect(out.stdout).not.toContain("FAILED");
    expect(out.exitCode).toBe(0);
    for (const language of ["python", "go", "rust"]) {
      expect(out.stdout).toContain(language);
    }
  });

  it("explains an unparseable target instead of hitting the network", async () => {
    const out = await run(["not a repo at all"]);
    expect(out.exitCode).toBe(1);
    expect(out.stderr).toContain("Not a directory");
  });
});

describe("terminal width", () => {
  it("wraps to COLUMNS rather than assuming a wide terminal", () => {
    // `process.stdout.columns` is undefined whenever output is piped, so
    // without COLUMNS there is no way to exercise narrow rendering at all.
    const previous = process.env["COLUMNS"];
    process.env["COLUMNS"] = "54";
    try {
      const out = renderReport(result(), "founder");
      const longest = Math.max(
        ...out.split("\n").map((l) => l.replace(/\u001b\[[0-9;]*m/g, "").length),
      );
      expect(longest).toBeLessThanOrEqual(54);
    } finally {
      if (previous === undefined) delete process.env["COLUMNS"];
      else process.env["COLUMNS"] = previous;
    }
  });
});

import { CURRENT_SCHEMA_VERSION, type ScanResult } from "@vibe/shared";
import { describe, expect, it } from "vitest";

import { readScanResult } from "./migrate";

/**
 * A result in the shape the engine writes today, as an opaque record.
 *
 * Deliberately built as a plain object rather than typed as `ScanResult`: every
 * test below removes a field to imitate a row written before that field
 * existed, and the type would reject exactly the rows this function exists to
 * survive.
 */
function current(): Record<string, unknown> {
  return {
    schemaVersion: 1,
    repo: {
      kind: "github",
      name: "owner/repo",
      rootPath: "/tmp/repo-audit-abc123",
      hasGitHistory: true,
      fileCount: 10,
      sourceFileCount: 8,
      totalLoc: 400,
      frameworks: [],
      languages: [],
      analysisTier: "full",
    },
    scores: [
      { dimension: "authorship", score: 12, confidence: "high", signals: [], unavailable: [] },
      { dimension: "health", score: 4, confidence: "high", signals: [], unavailable: [] },
    ],
    findings: [],
    metrics: [],
    analysedDimensions: ["authorship", "security", "health"],
    durationMs: 1234,
    warnings: [],
  };
}

describe("readScanResult", () => {
  it("passes a current result through unchanged apart from the server path", () => {
    const result = readScanResult(current());

    expect(result).not.toBeNull();
    expect(result!.schemaVersion).toBe(CURRENT_SCHEMA_VERSION);
    expect(result!.analysedDimensions).toEqual([
      "authorship",
      "security",
      "health",
    ]);
    expect(result!.repo.name).toBe("owner/repo");
    // Stripped on write; normalised again on read so an older row cannot carry
    // one through either.
    expect(result!.repo.rootPath).toBe("");
  });

  /*
   * The crash this whole file exists to prevent. `analysedDimensions` is a
   * required field added long after the first rows were stored, and
   * `Report.tsx` calls `.includes()` on it directly.
   */
  it("reconstructs analysedDimensions for a row written before the field existed", () => {
    const row = current();
    delete row["analysedDimensions"];

    const result = readScanResult(row);

    expect(result).not.toBeNull();
    // Inferred from the scores actually present — never invented. Security has
    // no score on this row, so it is not claimed.
    expect(result!.analysedDimensions).toEqual(["authorship", "health"]);
    expect(() => result!.analysedDimensions.includes("security")).not.toThrow();
  });

  it("drops a dimension name it does not recognise", () => {
    const row = current();
    row["analysedDimensions"] = ["authorship", "architecture", "quality"];

    // `quality` and `architecture` were real dimensions once and were folded
    // into `health`; a row can still name them.
    expect(readScanResult(row)!.analysedDimensions).toEqual(["authorship"]);
  });

  it("defaults the array fields a renderer maps over", () => {
    const row = current();
    delete row["findings"];
    delete row["metrics"];
    delete row["warnings"];

    const result = readScanResult(row);

    expect(result!.findings).toEqual([]);
    expect(result!.metrics).toEqual([]);
    expect(result!.warnings).toEqual([]);
  });

  // ---- the refusals, which matter more than the repairs --------------------

  it("refuses a row with no scores rather than inventing an empty report", () => {
    const row = current();
    delete row["scores"];

    // An empty `scores` array would render as a confident report about a
    // repository nothing was measured on.
    expect(readScanResult(row)).toBeNull();
  });

  it("refuses a row with no repo", () => {
    const row = current();
    delete row["repo"];
    expect(readScanResult(row)).toBeNull();
  });

  it("refuses a version this code was not written for", () => {
    const row = current();
    row["schemaVersion"] = CURRENT_SCHEMA_VERSION + 1;

    // A newer writer may have changed the meaning of a field rather than added
    // one. Rendering it anyway would be a guess presented as a measurement.
    expect(readScanResult(row)).toBeNull();
  });

  it("refuses values that are not a result at all", () => {
    for (const value of [null, undefined, "", 0, [], "not json"]) {
      expect(readScanResult(value)).toBeNull();
    }
  });

  it("returns something the report can consume as a ScanResult", () => {
    const result: ScanResult | null = readScanResult(current());
    expect(result?.scores).toHaveLength(2);
  });
});

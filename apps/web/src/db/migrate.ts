import {
  CURRENT_SCHEMA_VERSION,
  DIMENSIONS,
  type Dimension,
  type ScanResult,
} from "@vibe/shared";

/**
 * Bring a stored scan up to the shape the report expects, or refuse it.
 *
 * **Every read of a persisted `ScanResult` goes through here.** A result is
 * written as jsonb and read back weeks later by whatever code is deployed then,
 * so a row is not an instance of the current interface — it is an instance of
 * whatever the interface was on the day it was written, and TypeScript cannot
 * tell the difference. `Report.tsx` used to reach straight into
 * `result.analysedDimensions`, a *required* field added long after the first
 * rows existed; on one of those rows that is `undefined.includes(...)` and the
 * page throws.
 *
 * The same crash already happened once with `focus`, and the fix then was
 * applied to that one field. This is the same fix applied to the class: one
 * place that knows what every field added since v1 should default to, so the
 * next field added has an obvious home and the renderer can stop guessing.
 *
 * **Refuses rather than repairs when the core is missing.** A row with no
 * `scores` is not an old result, it is a broken one, and inventing an empty
 * array for it would render a confident report about a repository nothing was
 * ever measured on. Returning `null` puts it down the "that scan didn't finish"
 * path the page already has.
 */
export function readScanResult(raw: unknown): ScanResult | null {
  if (!isRecord(raw)) return null;

  // A version from the future is not something this code can honestly render.
  const version = raw["schemaVersion"];
  if (typeof version === "number" && version > CURRENT_SCHEMA_VERSION) {
    return null;
  }

  const repo = raw["repo"];
  if (!isRecord(repo) || typeof repo["name"] !== "string") return null;
  if (!Array.isArray(raw["scores"])) return null;

  return {
    ...(raw as unknown as ScanResult),
    schemaVersion: CURRENT_SCHEMA_VERSION,
    repo: {
      ...(repo as unknown as ScanResult["repo"]),
      /*
       * Absent on rows written before the strip landed, and absent from every
       * row written after it. Either way the report never wants a server path,
       * so it is normalised to empty rather than carried through.
       */
      rootPath: "",
    },
    /*
     * Added after the first rows, and read unguarded by the report. Defaulting
     * to the dimensions that actually have a score is the honest reconstruction:
     * a dimension carrying a number was analysed, whatever the row remembers.
     */
    analysedDimensions: dimensionsOf(raw),
    findings: Array.isArray(raw["findings"]) ? raw["findings"] : [],
    metrics: Array.isArray(raw["metrics"]) ? raw["metrics"] : [],
    warnings: Array.isArray(raw["warnings"]) ? raw["warnings"] : [],
    durationMs: typeof raw["durationMs"] === "number" ? raw["durationMs"] : 0,
  } as ScanResult;
}

/**
 * Which dimensions this row can claim were analysed.
 *
 * Trusts the stored array when it is there, and otherwise infers from the
 * scores present. Inferring is only correct in this direction: a dimension with
 * a score was certainly looked at, whereas the absence of the field says
 * nothing about a dimension that was never registered.
 */
function dimensionsOf(raw: Record<string, unknown>): Dimension[] {
  const stored = raw["analysedDimensions"];
  if (Array.isArray(stored)) {
    return stored.filter((d): d is Dimension =>
      DIMENSIONS.includes(d as Dimension),
    );
  }

  const scores = Array.isArray(raw["scores"]) ? raw["scores"] : [];
  return DIMENSIONS.filter((d) =>
    scores.some((s) => isRecord(s) && s["dimension"] === d),
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

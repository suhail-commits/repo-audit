import type { Finding, Severity, Signal } from "@vibe/shared";

import { ramp, unavailable, type AnalysisContext } from "../context";
import { collectPackages, type InstalledPackage } from "./lockfiles";
import { queryOsv, type OsvOptions, type VulnerablePackage } from "./osv";

/**
 * Dependencies with published vulnerabilities.
 *
 * **The whole transitive tree is checked**, which is the decision that makes
 * this useful and also the one that could sink it. Most real vulnerabilities
 * are transitive, so checking only direct dependencies would miss the majority
 * — but reporting forty advisories in build tooling the reader never chose and
 * cannot directly upgrade is precisely how `npm audit` became something people
 * ignore.
 *
 * Two things keep it readable:
 *
 * - **Runtime before dev.** A vulnerability in code that ships is a different
 *   claim from one in a test runner. Dev-only findings are reported at `low`
 *   and are kept out of the signal's numerator.
 * - **Nothing is silently dropped.** The detail budget, the undetailed
 *   advisories, and the count of dev-only findings are all stated. A truncated
 *   list that does not say it was truncated reads as "this is everything".
 */

export const WEIGHT = 2.5;

export interface DependencyOptions {
  osv?: OsvOptions;
}

export interface DependencyReport {
  vulnerable: VulnerablePackage[];
  runtime: VulnerablePackage[];
  undetailed: number;
  checked: number;
  failure?: string;
}

export async function analyzeDependencies(
  ctx: AnalysisContext,
  options: DependencyOptions = {},
): Promise<DependencyReport> {
  const packages = collectPackages(ctx);
  const result = await queryOsv(packages, options.osv ?? {});

  return {
    vulnerable: result.vulnerable,
    runtime: result.vulnerable.filter((v) => !v.pkg.devOnly),
    undetailed: result.undetailed,
    checked: packages.length,
    ...(result.failure ? { failure: result.failure } : {}),
  };
}

export function vulnerableDependencySignal(report: DependencyReport): Signal {
  const id = "vulnerable-dependencies";

  if (report.failure) {
    return unavailable(id, WEIGHT, report.failure);
  }
  if (report.checked === 0) {
    return unavailable(
      id,
      WEIGHT,
      "no lockfile or pinned manifest was found to check",
    );
  }

  const evidence: string[] = [];
  if (report.vulnerable.length > 0) {
    evidence.push(
      `${report.runtime.length} of ${report.checked} installed packages have known vulnerabilities` +
        (report.vulnerable.length > report.runtime.length
          ? ` (plus ${report.vulnerable.length - report.runtime.length} in dev-only tooling)`
          : ""),
    );
    for (const entry of report.runtime.slice(0, 4)) {
      const worst = entry.advisories[0];
      evidence.push(
        `${entry.pkg.name} ${entry.pkg.version} — ${worst?.id ?? "advisory"}` +
          (worst?.summary ? `: ${worst.summary}` : ""),
      );
    }
  } else {
    evidence.push(`${report.checked} installed packages checked, none affected`);
  }

  if (report.undetailed > 0) {
    // Said out loud: a capped list that does not admit the cap reads as a
    // complete one.
    evidence.push(
      `${report.undetailed} further advisories were found but not described — the lookup budget was reached`,
    );
  }

  return {
    id,
    /*
     * Ramped on the runtime count rather than saturating. Unlike a committed
     * credential, one advisory in one transitive package is a normal state for
     * a healthy project — every large dependency tree has some — so the signal
     * has to distinguish "one" from "twenty".
     */
    value: ramp(report.runtime.length, 0, 8),
    weight: WEIGHT,
    available: true,
    evidence,
  };
}

export function vulnerableDependencyFindings(
  report: DependencyReport,
): Finding[] {
  if (report.failure || report.vulnerable.length === 0) return [];

  const findings: Finding[] = [];

  const runtime = report.runtime;
  if (runtime.length > 0) {
    findings.push({
      ruleId: "vulnerable-dependency",
      dimension: "security",
      severity: worstSeverity(runtime),
      // OSV is authoritative about which versions are affected; whether the
      // vulnerable path is reachable from this codebase is not something we
      // determine.
      confidence: "high",
      source: "osv",
      title: `${runtime.length} shipped ${
        runtime.length === 1 ? "dependency has" : "dependencies have"
      } known vulnerabilities`,
      locations: [...new Set(runtime.map((v) => v.pkg.source))].map((file) => ({
        file,
      })),
      data: {
        packages: runtime
          .slice(0, 12)
          .map((v) => describePackage(v)),
        count: runtime.length,
        checked: report.checked,
        undetailed: report.undetailed,
      },
      estimatedFixMinutes: 20 * Math.min(runtime.length, 9),
    });
  }

  const dev = report.vulnerable.filter((v) => v.pkg.devOnly);
  if (dev.length > 0) {
    findings.push({
      ruleId: "vulnerable-dev-dependency",
      dimension: "security",
      // Build tooling is not attacker-reachable in production. Reported so the
      // list is complete, ranked so it does not crowd out what ships.
      severity: "low",
      confidence: "high",
      source: "osv",
      title: `${dev.length} development ${
        dev.length === 1 ? "dependency has" : "dependencies have"
      } known vulnerabilities`,
      locations: [...new Set(dev.map((v) => v.pkg.source))].map((file) => ({
        file,
      })),
      data: {
        packages: dev.slice(0, 12).map((v) => describePackage(v)),
        count: dev.length,
      },
      estimatedFixMinutes: 30,
    });
  }

  return findings;
}

/** "lodash 4.17.20 — GHSA-… (via webpack)". */
function describePackage(entry: VulnerablePackage): string {
  const ids = entry.advisories.map((a) => a.id).slice(0, 3).join(", ");
  const via = entry.pkg.direct ? "" : viaSuffix(entry.pkg);
  return `${entry.pkg.name} ${entry.pkg.version} — ${ids}${via}`;
}

function viaSuffix(pkg: InstalledPackage): string {
  return pkg.via ? ` (via ${pkg.via})` : " (transitive)";
}

function worstSeverity(entries: VulnerablePackage[]): Severity {
  const levels = entries.flatMap((e) => e.advisories.map((a) => a.severity));
  if (levels.includes("critical")) return "critical";
  if (levels.includes("high")) return "high";
  // Everything else, including advisories whose severity OSV did not supply.
  return "medium";
}

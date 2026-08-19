import type { DimensionScore, Finding, Signal } from "@vibe/shared";

import { scoreDimension } from "../../score/index";
import { unavailable, type AnalysisContext } from "../context";
import { authCoverageFindings, authCoverageSignal } from "./auth";
import {
  analyzeDependencies,
  vulnerableDependencyFindings,
  vulnerableDependencySignal,
  WEIGHT as DEPENDENCY_WEIGHT,
  type DependencyOptions,
} from "./deps";
import {
  licenseFindings,
  licenseMismatchSignal,
  licenseWarnings,
  missingLicenseSignal,
  readLicense,
} from "./license";
import {
  committedEnvFindings,
  committedEnvSignal,
  hardcodedSecretFindings,
  hardcodedSecretsSignal,
} from "./secrets";
import { dangerousCallFindings, dangerousCallSignal } from "./sinks";

/**
 * What is exposed?
 *
 * **The signals here are presence-shaped, and that is the one real departure
 * from how the other two dimensions work.** Every authorship and health signal
 * is a ratio — "31% of functions are clones" — because those questions are
 * genuinely proportional. Security is not: one committed AWS key in a 500-file
 * repository is a ratio of 0.002, which scores ~0 and renders as *solid*. So
 * the credential signals saturate on their first real hit and the count lives
 * in the finding instead.
 *
 * Not all of them: `unauthenticated-routes` is a real proportion, because
 * "half the mutating routes are open" says something different from "one is".
 * `dangerous-calls` and `vulnerable-dependencies` ramp for the same reason —
 * every large dependency tree carries some advisory, and one `eval` is not by
 * itself full exposure.
 *
 * The consequence is a jumpier score than the other two sections have, which
 * is intended, and it means the section headline must come from the worst
 * finding rather than from the score: `8/100` with a live credential in it is
 * still a critical result.
 *
 * Confidence needs no special handling — `scoreDimension` derives it from
 * coverage, which is the right answer here for free. A repository with no
 * JavaScript reports the route and sink checks unavailable, coverage falls,
 * confidence falls, and the score is left alone.
 */

export interface SecurityResult {
  score: DimensionScore;
  findings: Finding[];
  /**
   * What this dimension could not look at, for the report's "what we could and
   * couldn't read" list. Distinct from an unavailable signal: these are
   * permanent boundaries of the analysis rather than evidence missing from the
   * repository in front of us, and treating them as the latter would lower
   * confidence on every scan forever.
   */
  warnings: string[];
}

export interface SecurityOptions extends DependencyOptions {
  /**
   * Look dependencies up against OSV. **Off by default**, because it is the
   * only analysis in the engine that reaches the network: a test that forgot
   * to opt out would make real requests, and a library that phones home unless
   * told otherwise is the wrong default. The CLI and the web app turn it on.
   */
  checkVulnerabilities?: boolean;
}

export async function analyzeSecurity(
  ctx: AnalysisContext,
  options: SecurityOptions = {},
): Promise<SecurityResult> {
  // Read once, derived three times below.
  const license = readLicense(ctx);

  const signals: Signal[] = [
    hardcodedSecretsSignal(ctx),
    committedEnvSignal(ctx),
    authCoverageSignal(ctx),
    dangerousCallSignal(ctx),
    missingLicenseSignal(license),
    licenseMismatchSignal(license),
  ];

  const findings: Finding[] = [
    ...hardcodedSecretFindings(ctx),
    ...committedEnvFindings(ctx),
    ...authCoverageFindings(ctx),
    ...dangerousCallFindings(ctx),
    ...licenseFindings(license),
  ];

  /*
   * Registered either way. When the lookup is switched off the signal reports
   * unavailable with that as its reason, rather than vanishing from the list —
   * a shorter signal list would silently redistribute its weight across the
   * others and the breakdown would show four checks where the analyzer has
   * five. Invariant 2: a missing input lowers confidence, never the score.
   */
  if (options.checkVulnerabilities) {
    const report = await analyzeDependencies(ctx, options);
    signals.push(vulnerableDependencySignal(report));
    findings.push(...vulnerableDependencyFindings(report));
  } else {
    signals.push(
      unavailable(
        "vulnerable-dependencies",
        DEPENDENCY_WEIGHT,
        "the vulnerability database was not consulted for this scan",
      ),
    );
  }

  return {
    score: scoreDimension("security", signals, {
      sourceFiles: ctx.files.sourceFiles().map((f) => f.relPath),
      /*
       * Matters most here of the three. A secret scan that read four fifths of
       * the files and found nothing is not a repository with no secrets, and
       * this is the dimension where that difference is expensive.
       */
      truncated: ctx.files.truncated,
    }),
    findings,
    warnings: licenseWarnings(),
  };
}

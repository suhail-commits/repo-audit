import {
  confidencePhrase,
  authorshipBand,
  healthBand,
  severityRank,
  type DimensionScore,
  type Finding,
  type Persona,
  type ScanResult,
} from "@vibe/shared";

import { countOf, list } from "./format";
import { evidenceLine, templateFor } from "./templates";
import type {
  NarratedFinding,
  NarratedReport,
  NarratedScore,
  Narrator,
} from "./types";

/**
 * The deterministic narrator: every sentence comes from a hand-written template
 * filled with values the analyzers measured.
 *
 * Nothing here can assert something that was not computed, and the same scan
 * always produces the same words.
 */
export class TemplateNarrator implements Narrator {
  finding(finding: Finding, persona: Persona): NarratedFinding {
    const template = templateFor(finding.ruleId);
    const personaTemplate = template[persona];

    return {
      ruleId: finding.ruleId,
      dimension: finding.dimension,
      severity: finding.severity,
      title: template.title(finding.data, finding),
      body: personaTemplate.body(finding.data, finding),
      detail: personaTemplate.detail?.(finding.data, finding) ?? [],
      locations: finding.locations,
    };
  }

  score(score: DimensionScore, persona: Persona): NarratedScore {
    return {
      dimension: score.dimension,
      score: score.score,
      headline: this.scoreHeadline(score, persona),
      evidence: this.scoreEvidence(score),
      caveats: this.scoreCaveats(score, persona),
    };
  }

  report(result: ScanResult, persona: Persona): NarratedReport {
    const scores = result.scores.map((s) => this.score(s, persona));

    // Worst first; ties broken by how many places the problem appears.
    const findings = [...result.findings]
      .sort(
        (a, b) =>
          severityRank(b.severity) - severityRank(a.severity) ||
          b.locations.length - a.locations.length,
      )
      .map((f) => this.finding(f, persona));

    return {
      persona,
      headline: scores[0]?.headline ?? "No analysis was produced for this repository.",
      summary: this.summary(result, persona),
      verdict: this.verdict(result, persona),
      scores,
      findings,
    };
  }

  // -------------------------------------------------------------------------

  /**
   * What the reader should take away.
   *
   * Every clause here is derived from a counted value — the band, how many
   * findings exist, how many signals ran. Nothing is asserted that was not
   * measured, which is the line that keeps this from becoming an opinion column.
   */
  private verdict(result: ScanResult, persona: Persona): string {
    const authorship = result.scores.find((s) => s.dimension === "authorship");
    if (!authorship) return "";

    const band = authorshipBand(authorship.score);
    const findings = result.findings.filter((f) => f.severity !== "info").length;
    const measured = authorship.signals.filter((s) => s.available).length;
    const total = authorship.signals.length;
    const thin = measured < total * 0.6;

    if (persona === "engineer") {
      const parts = [
        `Authorship ${authorship.score}/100 (${band}), ${measured}/${total} signals.`,
      ];
      parts.push(
        findings === 0
          ? "No actionable findings."
          : `${countOf(findings, "actionable finding")} below.`,
      );
      if (thin) {
        parts.push("Coverage is thin — treat the score as indicative.");
      }
      return parts.join(" ");
    }

    if (persona === "acquirer") {
      const effort = result.findings.reduce(
        (sum, f) => sum + (f.estimatedFixMinutes ?? 0),
        0,
      );
      const base =
        band === "unlikely" || band === "possible"
          ? "Nothing here suggests the codebase was largely generated."
          : "Expect a substantial share of this codebase to have been generated.";
      const work =
        effort === 0
          ? "No remediation was identified."
          : `Identified remediation is roughly ${Math.max(1, Math.round(effort / 60))} developer hours.`;
      return thin
        ? `${base} ${work} Coverage was limited, so treat this as indicative rather than settled.`
        : `${base} ${work}`;
    }

    /*
     * Owner. The opening is driven by whether there is anything to *do*, not by
     * the band — those are different axes, and keying off the band produced
     * "Nothing here needs your attention. We found 6 things worth fixing."
     */
    const opening =
      findings === 0
        ? "Nothing here needs your attention."
        : findings <= 2
          ? `${countOf(findings, "thing")} ${findings === 1 ? "is" : "are"} worth a look, but nothing alarming.`
          : `${countOf(findings, "thing")} are worth going through.`;

    const context =
      band === "unlikely" || band === "possible"
        ? "The code itself shows few of the patterns we associate with generated work."
        : "The code shows several of the patterns we associate with generated work.";

    const caveat = thin
      ? " We could only run some of our checks on this project, so treat this as a first impression."
      : "";

    return `${opening} ${context}${caveat}`;
  }

  private scoreHeadline(score: DimensionScore, persona: Persona): string {
    if (score.dimension === "health") {
      return this.healthHeadline(score, persona);
    }
    if (score.dimension !== "authorship") {
      return `${score.dimension}: ${score.score}/100`;
    }

    const band = authorshipBand(score.score);

    if (persona === "engineer") {
      const available = score.signals.filter((s) => s.available).length;
      return (
        `Authorship ${score.score}/100 — ${band} to be AI-generated ` +
        `(${score.confidence} confidence, ${available}/${score.signals.length} signals available)`
      );
    }

    if (persona === "acquirer") {
      return (
        `AI-generation likelihood: ${score.score}/100 (${band}), ` +
        `${score.confidence} confidence`
      );
    }

    /*
     * Never say "hand-written" when the repository itself carries evidence of
     * AI tooling. A low score means the *code* shows few of the usual patterns,
     * which is a different claim from "no AI was involved" — and stating the
     * second when we have direct evidence of the first reads as a broken tool.
     *
     * This is the shape the confidence bug took in the narrator: the report used
     * to headline "this mostly looks like hand-written code" directly above
     * "Claude Code: CLAUDE.md present".
     */
    if (band === "unlikely" && hasDirectEvidence(score)) {
      return "AI tools were used on this project, but the code itself shows few of the usual signs.";
    }

    switch (band) {
      case "near-certain":
        return "This app was almost certainly built with AI coding tools.";
      case "likely":
        return "This app was probably built largely with AI coding tools.";
      case "possible":
        return "Parts of this app look like they were written by AI coding tools.";
      case "unlikely":
        return "This mostly looks like hand-written code.";
    }
  }

  /**
   * The code-health verdict.
   *
   * The number runs the same direction as authorship — higher is more problems
   * — so the sentence has to carry that, or "62 / 100" reads as a pass mark.
   * Every phrasing here names what was found rather than grading the codebase:
   * we measured duplication and missing tests, which is not the same as knowing
   * whether the code is any good.
   */
  private healthHeadline(score: DimensionScore, persona: Persona): string {
    const band = healthBand(score.score);
    const measured = score.signals.filter((s) => s.available).length;

    /*
     * One signal at full value inside an otherwise clean set averages down to a
     * low score, and "the code is in good shape" then sits directly above "319
     * of 917 test cases assert nothing at all". Seen on `sindresorhus/execa`.
     *
     * This is the same failure the authorship headline has a guard for: a band
     * describes the aggregate, and the aggregate is not entitled to overrule a
     * specific thing we measured and are about to print.
     */
    const standouts = score.signals.filter((s) => s.available && s.value >= 0.5);
    const clean = band === "solid" && standouts.length === 0;

    if (persona === "engineer") {
      // Already unambiguous: it states the number, the direction and coverage.
      return (
        `Code health ${score.score}/100 — ${band.replace("-", " ")} ` +
        `(higher is worse; ${measured}/${score.signals.length} signals available)`
      );
    }

    if (persona === "acquirer") {
      switch (band) {
        case "poor":
          return `Substantial maintenance debt: ${score.score}/100 on problems found.`;
        case "rough":
          return `Meaningful maintenance debt: ${score.score}/100 on problems found.`;
        case "minor-issues":
          return `Ordinary maintenance debt for a codebase this size (${score.score}/100).`;
        case "solid":
          return clean
            ? `Little maintenance debt found (${score.score}/100).`
            : `Low maintenance debt overall (${score.score}/100), concentrated in ${countOf(standouts.length, "area")}.`;
      }
    }

    switch (band) {
      case "poor":
        return "There is a lot here that will slow down future changes.";
      case "rough":
        return "A fair amount here will make future changes harder than they need to be.";
      case "minor-issues":
        return "A few rough edges, nothing unusual for a codebase this size.";
      case "solid":
        return clean
          ? "The code is in good shape on the things we can measure."
          : "Mostly in good shape, but a few specific things stand out below.";
    }
  }

  /** Evidence comes only from signals that actually fired. */
  private scoreEvidence(score: DimensionScore): string[] {
    return score.signals
      .filter((s) => s.available && s.value > 0.15 && s.evidence.length > 0)
      .sort((a, b) => b.value * b.weight - a.value * a.weight)
      .flatMap((s) => s.evidence)
      .map(evidenceLine);
  }

  private scoreCaveats(score: DimensionScore, persona: Persona): string[] {
    if (score.unavailable.length === 0) {
      return persona === "founder" ? [] : [confidencePhrase(score.confidence)];
    }

    const reasons = [...new Set(score.unavailable)];

    if (persona === "founder") {
      return [
        `A lower score from missing evidence is not a cleaner codebase — ` +
          `it only means we had less to go on. Skipped: ${list(reasons)}.`,
      ];
    }

    return [
      confidencePhrase(score.confidence),
      `Unavailable: ${list(reasons, 6)}.`,
    ];
  }

  private summary(result: ScanResult, persona: Persona): string {
    const { repo } = result;
    // Both figures are measured over authored source, so they agree.
    const size = `${countOf(repo.totalLoc, "line")} of code across ${countOf(repo.sourceFileCount, "source file")}`;
    const stack =
      repo.frameworks.length > 0 ? ` Built with ${list(repo.frameworks)}.` : "";

    // Name the languages so the reader can tell whether the checks that matter
    // to them actually ran.
    const languages = repo.languages
      .filter((l) => l.share >= 0.05)
      .map((l) => l.label);
    const written =
      languages.length > 0 ? ` Written in ${list(languages, 3)}.` : "";

    if (persona === "engineer") {
      return (
        `${repo.name} — ${size}.${written}${stack} ` +
        `${repo.hasGitHistory ? "Git history analyzed" : "No git history available"}; ` +
        `${countOf(result.findings.length, "finding")} in ${result.durationMs}ms.`
      );
    }

    if (persona === "acquirer") {
      const effort = result.findings.reduce(
        (sum, f) => sum + (f.estimatedFixMinutes ?? 0),
        0,
      );
      return (
        `${repo.name} comprises ${size}.${written}${stack} ` +
        `Identified remediation across all findings totals roughly ` +
        `${Math.max(1, Math.round(effort / 60))} developer hours.`
      );
    }

    return (
      `We looked at ${size} in your project.${written}${stack} ` +
      (repo.hasGitHistory
        ? "We were able to review your project's full history."
        : "We could not see your project's history, so some checks were skipped.")
    );
  }
}

/**
 * Signals whose firing is an artifact of AI tooling rather than an inference
 * about the code: a commit trailer, a builder marker, a committed agent config.
 */
const DIRECT_EVIDENCE_SIGNALS = new Set([
  "agent-trailers",
  "builder-platform",
  "agent-tooling",
]);

function hasDirectEvidence(score: DimensionScore): boolean {
  return score.signals.some(
    (s) => s.available && s.value > 0 && DIRECT_EVIDENCE_SIGNALS.has(s.id),
  );
}

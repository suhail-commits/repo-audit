import {
  confidencePhrase,
  provenanceBand,
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
      scores,
      findings,
    };
  }

  // -------------------------------------------------------------------------

  private scoreHeadline(score: DimensionScore, persona: Persona): string {
    if (score.dimension !== "provenance") {
      return `${score.dimension}: ${score.score}/100`;
    }

    const band = provenanceBand(score.score);

    if (persona === "engineer") {
      const available = score.signals.filter((s) => s.available).length;
      return (
        `Provenance ${score.score}/100 — ${band} to be AI-generated ` +
        `(${score.confidence} confidence, ${available}/${score.signals.length} signals available)`
      );
    }

    if (persona === "acquirer") {
      return (
        `AI-generation likelihood: ${score.score}/100 (${band}), ` +
        `${score.confidence} confidence`
      );
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
        `Some checks could not run: ${list(reasons)}. ` +
          `That means this score is based on less evidence than usual — not that the code is cleaner.`,
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

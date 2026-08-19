import {
  TemplateNarrator,
  corpusComparison,
  coverageLine,
  dimensionLabel,
  hotspotCaveat,
  hotspotTitle,
  prioritiesCaveat,
  prioritiesTitle,
  scoreCaption,
  signalLabel,
} from "@vibe/rules";
import {
  bandsFor,
  confidencePhrase,
  type Dimension,
  type DimensionScore,
  type Persona,
  type ScanResult,
  type Severity,
} from "@vibe/shared";

import {
  accent,
  alarm,
  bar,
  bold,
  dim,
  pad,
  padStart,
  rule,
  warn,
  width,
  wrap,
} from "../term";

/**
 * The report, as a terminal document.
 *
 * Pure: takes a `ScanResult` and returns a string. Nothing here prints, which
 * is the whole reason the CLI can be tested without spawning a process — the
 * two CLIs this replaces both called `main()` on import and exported nothing,
 * so neither had a single test.
 *
 * Content parity with the web report is deliberate rather than aspirational.
 * Every sentence below comes from `@vibe/rules`; where a number needed a
 * caption or a caveat, that prose was moved into the rules package rather than
 * rewritten here, so the two surfaces cannot describe the same repository
 * differently.
 */
export function renderReport(result: ScanResult, persona: Persona): string {
  const report = new TemplateNarrator().report(result, persona);
  const out: string[] = [];
  const cols = width();

  out.push("");
  out.push(rule(cols));
  out.push(bold(wrap(report.headline, "  ", cols)));
  out.push(rule(cols));
  out.push("");
  out.push(wrap(report.summary, "  ", cols));
  out.push("");
  out.push(wrap(report.verdict, "  ", cols));
  out.push("");
  out.push(renderFacts(result, cols));

  for (const narrated of report.scores) {
    const dimension = narrated.dimension as Dimension;
    const score = result.scores.find((s) => s.dimension === dimension);
    if (!score) continue;
    out.push(renderDimension(narrated.headline, score, persona, cols));
    for (const line of narrated.evidence) out.push(wrap(line, "    • ", cols));
    for (const caveat of narrated.caveats) out.push(wrap(caveat, "    ! ", cols));
    out.push("");
    const hotspots = renderHotspots(score, persona, cols);
    if (hotspots) out.push(hotspots);
  }

  if (report.priorities.length > 0) {
    const actionable = report.findings.filter((f) => f.severity !== "info").length;
    out.push(rule(cols));
    out.push(bold(`  ${prioritiesTitle(persona).toUpperCase()}`));
    out.push(
      wrap(prioritiesCaveat(report.priorities.length, actionable, persona), "  ", cols),
    );
    out.push(rule(cols));
    report.priorities.forEach((finding, i) => {
      const where = dimensionLabel(finding.dimension as Dimension, persona).title;
      out.push(
        wrap(
          `${finding.title} (${where})`,
          `  ${i + 1}. ${severityTag(finding.severity)} `,
          cols,
        ),
      );
    });
    out.push("");
  }

  if (report.findings.length > 0) {
    out.push(rule(cols));
    out.push(bold(`  WHAT WE FOUND (${report.findings.length})`));
    out.push(rule(cols));
    for (const finding of report.findings) {
      out.push("");
      out.push(wrap(finding.title, `  ${severityTag(finding.severity)} `, cols));
      out.push(wrap(finding.body, "    ", cols));
      for (const detail of finding.detail) out.push(wrap(detail, "    → ", cols));
      for (const loc of finding.locations.slice(0, 3)) {
        out.push(dim(`      ${loc.file}${loc.line ? `:${loc.line}` : ""}`));
      }
      if (finding.locations.length > 3) {
        out.push(dim(`      …and ${finding.locations.length - 3} more`));
      }
    }
    out.push("");
  }

  const metrics = renderMetrics(result, cols);
  if (metrics) out.push(metrics);

  if (result.warnings.length > 0) {
    out.push(bold("  WHAT WE COULD AND COULDN'T READ"));
    for (const w of result.warnings) out.push(wrap(w, "    - ", cols));
    out.push("");
  }

  out.push(
    dim(`  No code from this repository was executed. ${result.durationMs}ms.`),
  );
  out.push("");
  return out.join("\n");
}

/**
 * The facts strip.
 *
 * `headSha` is here because nothing else says *which revision* was measured,
 * and the same project legitimately reads differently from a local checkout
 * than through the API when there is unpushed work — 11,436 lines against
 * 7,519 on one afternoon. Without the revision the reader has no way to
 * account for that.
 */
function renderFacts(result: ScanResult, cols: number): string {
  const { repo } = result;
  const facts: [string, string][] = [
    ["Repository", repo.name],
    ["Source files", `${repo.sourceFileCount.toLocaleString()} of ${repo.fileCount.toLocaleString()}`],
    ["Lines of source", repo.totalLoc.toLocaleString()],
    [
      "Languages",
      repo.languages.length > 0
        ? repo.languages
            .slice(0, 4)
            .map((l) => `${l.label} ${Math.round(l.share * 100)}%`)
            .join(", ")
        : "none detected",
    ],
    ["Analysis tier", repo.analysisTier],
  ];
  if (repo.frameworks.length > 0) {
    facts.push(["Stack", repo.frameworks.join(", ")]);
  }
  facts.push([
    "History",
    repo.hasGitHistory ? "git history available" : "no git history",
  ]);
  if (repo.headSha) facts.push(["Revision", repo.headSha.slice(0, 7)]);

  const labelWidth = Math.max(...facts.map(([k]) => k.length));
  return facts
    .map(([k, v]) => wrap(v, `  ${dim(pad(k, labelWidth))}  `, cols))
    .join("\n");
}

/** One dimension: headline, the number on its band scale, and coverage. */
function renderDimension(
  headline: string,
  score: DimensionScore,
  persona: Persona,
  cols: number,
): string {
  const label = dimensionLabel(score.dimension, persona);
  const measured = score.signals.filter((s) => s.available).length;

  const out: string[] = [];
  out.push("");
  out.push(rule(cols));
  out.push(
    `  ${bold(label.title.toUpperCase())}  ${accent(`${score.score}/100`)}` +
      dim(`  ${scoreCaption(score.dimension, persona)}`),
  );
  out.push(rule(cols));
  out.push(wrap(headline, "  ", cols));
  out.push("");
  out.push(renderScale(score, cols));
  out.push("");
  out.push(
    wrap(corpusComparison(score.dimension, score.score, persona), "  ~ ", cols),
  );
  out.push(dim(wrap(coverageLine(measured, score.signals.length), "  ", cols)));
  out.push(
    dim(wrap(`${confidencePhrase(score.confidence)}.`, "  ", cols)),
  );
  out.push("");
  return out.join("\n");
}

/**
 * The band scale, drawn.
 *
 * A bare "15 / 100" does not tell a reader whether high means more AI or less,
 * or whether 15 is normal — which is why the web report draws the ladder and
 * why the CLI should not print the number alone either.
 */
function renderScale(score: DimensionScore, cols: number): string {
  const bands = bandsFor(score.dimension);
  const track = Math.max(20, Math.min(cols - 24, 48));
  const marker = Math.round((score.score / 100) * (track - 1));

  const line =
    dim("─".repeat(marker)) + accent("▲") + dim("─".repeat(track - marker - 1));

  /*
   * The bands are a legend with their thresholds, not labels positioned under
   * the track.
   *
   * Positioning them there was the first attempt and it silently dropped
   * whichever label collided with its neighbour — on security, whose bands are
   * `nothing found / some / several / widespread`, the *first* band vanished
   * and the scale appeared to begin at "some". A legend always fits, wraps when
   * it has to, and states the boundaries, which the positional version never
   * did. The marker line above already carries the position.
   */
  const legend = bands.map((b) => `${b.from}+ ${b.label}`).join("  ·  ");

  const current =
    bands.filter((b) => score.score >= b.from).at(-1)?.label ??
    bands[0]?.label ??
    "";

  return [
    `  ${line}`,
    dim(wrap(legend, "  ", cols)),
    `  ${dim("→")} ${bold(current)}`,
  ].join("\n");
}

/** Where the signs concentrate — an ordering, never a per-folder score. */
function renderHotspots(
  score: DimensionScore,
  persona: Persona,
  cols: number,
): string | null {
  const hotspots = score.hotspots ?? [];
  if (hotspots.length === 0) return null;

  const contributing = new Set(hotspots.flatMap((h) => h.signals)).size;
  const pathWidth = Math.min(
    Math.max(...hotspots.map((h) => h.path.length)),
    Math.max(16, cols - 40),
  );

  const out: string[] = [];
  out.push(`  ${bold(hotspotTitle(score.dimension, persona))}`);
  for (const spot of hotspots) {
    const label = spot.path.length > pathWidth
      ? `…${spot.path.slice(-(pathWidth - 1))}`
      : spot.path;
    out.push(
      `    ${pad(label, pathWidth)}  ${bar(spot.intensity, 16)}  ` +
        dim(`${spot.files} ${spot.files === 1 ? "file" : "files"}`),
    );
    out.push(
      dim(
        wrap(
          spot.signals
            .slice(0, 3)
            .map((id) => signalLabel(id, persona).label)
            .join(", "),
          "      ",
          cols,
        ),
      ),
    );
  }
  out.push(dim(wrap(hotspotCaveat(contributing, persona), "    ", cols)));
  out.push("");
  return out.join("\n");
}

/** Measurements, grouped under the dimension they belong to. */
function renderMetrics(result: ScanResult, cols: number): string | null {
  const metrics = result.metrics.filter((m) => m.value > 0);
  if (metrics.length === 0) return null;

  const labelWidth = Math.min(
    Math.max(...metrics.map((m) => m.label.length)),
    Math.max(20, cols - 20),
  );

  const out: string[] = [];
  out.push(bold("  MEASUREMENTS"));
  for (const m of metrics) {
    out.push(
      `    ${pad(m.label, labelWidth)}  ${padStart(m.value.toLocaleString(), 8)}`,
    );
  }
  out.push("");
  return out.join("\n");
}

/**
 * Severity as a text label, coloured but never colour-only.
 *
 * The word is always present, so the meaning survives a pipe, a screenshot in
 * greyscale, and `NO_COLOR`.
 */
function severityTag(severity: Severity): string {
  const text = `[${severity.toUpperCase()}]`;
  if (severity === "critical" || severity === "high") return alarm(text);
  if (severity === "medium") return warn(text);
  return dim(text);
}

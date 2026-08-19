import { dimensionLabel, scoreCaption, signalLabel } from "@vibe/rules";
import {
  contributions,
  type Persona,
  type ScanResult,
} from "@vibe/shared";

import { accent, bar, bold, dim, pad, padStart, rule, width } from "../term";

/**
 * The signal-by-signal breakdown — the calibration view.
 *
 * This is what `pnpm scan` printed, plus the two things it never did: the
 * plain-language name beside each id, and the **contribution in points**. The
 * old output gave `value` and `w=weight` and left the reader to multiply, which
 * meant the one claim the tool makes about itself — that the arithmetic is
 * checkable — required arithmetic to check.
 *
 * The ids stay, in dim text, because this view exists for whoever is tuning a
 * signal and they need the id to find the file.
 */
export function renderSignals(result: ScanResult, persona: Persona): string {
  const out: string[] = [];
  const cols = width();

  out.push("");
  out.push(`  ${bold(result.repo.name)}  ${dim(result.repo.analysisTier + " tier")}`);
  out.push(
    dim(
      `  ${result.repo.sourceFileCount.toLocaleString()} source files · ` +
        `${result.repo.totalLoc.toLocaleString()} lines · ` +
        `${result.repo.hasGitHistory ? "git history" : "no git history"}`,
    ),
  );

  for (const score of result.scores) {
    const rows = contributions(score.signals);
    const scale = Math.max(...rows.map((r) => r.maxPoints), 1);
    const nameWidth = Math.min(
      Math.max(...rows.map((r) => signalLabel(r.signal.id, persona).label.length)),
      Math.max(18, cols - 56),
    );

    out.push("");
    out.push(rule(cols));
    out.push(
      `  ${bold(dimensionLabel(score.dimension, persona).title.toUpperCase())}  ` +
        `${accent(`${score.score}/100`)}  ` +
        dim(`${score.confidence} confidence · ${scoreCaption(score.dimension, persona)}`),
    );
    out.push(rule(cols));

    const ordered = [...rows].sort((a, b) => {
      if (a.signal.available !== b.signal.available) {
        return a.signal.available ? -1 : 1;
      }
      return b.points - a.points;
    });

    for (const row of ordered) {
      const { signal } = row;
      const label = signalLabel(signal.id, persona).label;
      const name = pad(label, nameWidth);
      // The engineer persona's label *is* the id, so printing both would put
      // the same string twice on one row.
      const id = label === signal.id ? "" : `  ${signal.id}`;

      if (signal.available) {
        out.push(
          `  ${name}  ${bar(row.points / scale, 14)}  ` +
            `${padStart(row.points < 0.05 ? "0" : `+${row.points.toFixed(1)}`, 6)}  ` +
            dim(`${signal.value.toFixed(2)} × w${signal.weight}${id}`),
        );
      } else {
        /*
         * Never a zero-length bar. A zero bar reads as "measured, found
         * nothing", which inverts the invariant that a missing signal lowers
         * confidence rather than the score — the same reason the web breakdown
         * renders an em-dash here.
         */
        out.push(
          `  ${dim(name)}  ${dim(pad("— not measured", 14))}  ${padStart("—", 6)}` +
            dim(id),
        );
        out.push(
          dim(`  ${" ".repeat(nameWidth)}  ${signal.unavailableReason ?? "inputs unavailable"}`),
        );
      }

      for (const line of signal.evidence) {
        out.push(dim(`  ${" ".repeat(nameWidth)}  · ${line}`));
      }
    }

    const total = rows.reduce((sum, r) => sum + r.points, 0);
    out.push(
      dim(
        `  ${" ".repeat(nameWidth)}  points total ${total.toFixed(1)} → score ${score.score}`,
      ),
    );
  }

  if (result.warnings.length > 0) {
    out.push("");
    out.push(bold("  WARNINGS"));
    for (const w of result.warnings) out.push(dim(`    - ${w}`));
  }

  out.push("");
  out.push(dim(`  completed in ${result.durationMs}ms`));
  out.push("");
  return out.join("\n");
}

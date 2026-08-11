import { existsSync } from "node:fs";
import path from "node:path";

import { isValidSlug } from "./ingest/github";
import { provenanceBand } from "./score/index";
import { scanGitHubRepository, scanRepository } from "./scan";

/**
 * Development CLI for running a scan against a local checkout.
 *
 * The web app is the product; this exists so signals can be inspected and
 * calibrated directly against real repositories.
 *
 *   pnpm scan <path> [--json] [--structural-only]
 */
async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const flags = new Set(args.filter((a) => a.startsWith("--")));
  const target = args.find((a) => !a.startsWith("--"));

  if (!target) {
    console.error(
      "usage: pnpm scan <path-to-repo | owner/repo> [--json] [--structural-only]",
    );
    process.exitCode = 1;
    return;
  }

  const structuralOnly = flags.has("--structural-only");

  // A local path always wins, so a directory named like a slug still scans
  // locally rather than silently hitting the network.
  const result =
    !existsSync(target) && isValidSlug(target)
      ? await scanGitHubRepository(target, {
          structuralOnly,
          ...(process.env["GITHUB_TOKEN"]
            ? { token: process.env["GITHUB_TOKEN"] }
            : {}),
        })
      : await scanRepository(path.resolve(target), {
          kind: "zip",
          name: path.basename(path.resolve(target)),
          structuralOnly,
        });

  if (flags.has("--json")) {
    console.log(JSON.stringify(result, null, 2));
    return;
  }

  const { repo } = result;
  console.log(`\n${repo.name}`);
  console.log(
    `${repo.fileCount} files · ${repo.totalLoc.toLocaleString()} lines of source · ` +
      `${repo.hasGitHistory ? "git history available" : "no git history"}`,
  );
  if (repo.frameworks.length > 0) {
    console.log(`frameworks: ${repo.frameworks.join(", ")}`);
  }

  for (const score of result.scores) {
    console.log(
      `\n${score.dimension.toUpperCase()}  ${score.score}/100  ` +
        `(${score.confidence} confidence` +
        (score.dimension === "provenance"
          ? `, ${provenanceBand(score.score)} to be AI-generated)`
          : ")"),
    );

    for (const signal of score.signals) {
      const mark = signal.available ? "*" : " ";
      const value = signal.available ? signal.value.toFixed(2) : "----";
      console.log(
        `  ${mark} ${signal.id.padEnd(22)} ${value}  w=${signal.weight}` +
          (signal.available ? "" : `  (${signal.unavailableReason})`),
      );
      for (const line of signal.evidence) console.log(`      - ${line}`);
    }
  }

  if (result.findings.length > 0) {
    console.log(`\nFINDINGS (${result.findings.length})`);
    for (const finding of result.findings) {
      const where = finding.locations[0];
      console.log(
        `  [${finding.severity}] ${finding.title}` +
          (where ? `\n      ${where.file}${where.line ? `:${where.line}` : ""}` : ""),
      );
    }
  }

  const metrics = result.metrics.filter((m) => m.value > 0);
  if (metrics.length > 0) {
    console.log("\nMETRICS");
    for (const m of metrics) {
      console.log(`  ${m.label.padEnd(46)} ${m.value.toLocaleString()}`);
    }
  }

  if (result.warnings.length > 0) {
    console.log("\nWARNINGS");
    for (const w of result.warnings) console.log(`  - ${w}`);
  }

  console.log(`\ncompleted in ${result.durationMs}ms\n`);
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});

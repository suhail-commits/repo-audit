import path from "node:path";

import { scanRepository } from "@vibe/engine";
import { PERSONAS, type Dimension, type Persona } from "@vibe/shared";

import { corpusComparison } from "./corpus";
import { prioritiesCaveat, prioritiesTitle } from "./dimension-labels";
import { TemplateNarrator } from "./narrator";

/**
 * Renders a scan as the report a given persona would read.
 *
 *   pnpm report <path> [--persona=founder|engineer|acquirer]
 */
async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const target = args.find((a) => !a.startsWith("--"));
  const personaArg = args
    .find((a) => a.startsWith("--persona="))
    ?.split("=")[1] as Persona | undefined;

  if (!target) {
    console.error(
      `usage: pnpm report <path-to-repo> [--persona=${PERSONAS.join("|")}]`,
    );
    process.exitCode = 1;
    return;
  }

  const persona: Persona =
    personaArg && PERSONAS.includes(personaArg) ? personaArg : "founder";

  const rootPath = path.resolve(target);
  const result = await scanRepository(rootPath, {
    kind: "zip",
    name: path.basename(rootPath),
  });

  const report = new TemplateNarrator().report(result, persona);
  const rule = "─".repeat(72);

  console.log(`\n${rule}`);
  console.log(`  ${report.headline}`);
  console.log(`${rule}\n`);
  console.log(wrap(report.summary));
  console.log(`\n${wrap(report.verdict)}`);

  for (const score of report.scores) {
    console.log(`\n  ${score.dimension.toUpperCase()} — ${score.score}/100`);
    // Where the number sits against known hand-written code. The band words
    // say what we call a score; this says what one normally looks like.
    console.log(
      wrap(
        corpusComparison(score.dimension as Dimension, score.score, persona),
        "    ~ ",
      ),
    );
    for (const line of score.evidence) console.log(wrap(line, "    • "));
    for (const caveat of score.caveats) console.log(wrap(caveat, "    ! "));
  }

  /*
   * The shortlist, before the full list. Same reason the web report puts it
   * above the sections: "what first?" is a different question from "what did
   * you find in this area?", and only the CLI printed the second one.
   */
  if (report.priorities.length > 0) {
    const actionable = report.findings.filter(
      (f) => f.severity !== "info",
    ).length;
    console.log(`\n${rule}`);
    console.log(`  ${prioritiesTitle(persona).toUpperCase()}`);
    console.log(
      `  ${prioritiesCaveat(report.priorities.length, actionable, persona)}`,
    );
    console.log(`${rule}`);
    report.priorities.forEach((finding, i) => {
      console.log(
        `  ${i + 1}. [${finding.severity.toUpperCase()}] ${finding.title}` +
          `  (${finding.dimension})`,
      );
    });
  }

  if (report.findings.length > 0) {
    console.log(`\n${rule}`);
    console.log(`  WHAT WE FOUND (${report.findings.length})`);
    console.log(`${rule}`);

    for (const finding of report.findings) {
      console.log(`\n  [${finding.severity.toUpperCase()}] ${finding.title}`);
      console.log(wrap(finding.body, "    "));
      for (const detail of finding.detail) console.log(wrap(detail, "    → "));
      for (const loc of finding.locations.slice(0, 3)) {
        console.log(`      ${loc.file}${loc.line ? `:${loc.line}` : ""}`);
      }
    }
  }

  console.log();
}

/** Soft-wrap to a readable width, preserving the indent prefix. */
function wrap(text: string, prefix = "  ", width = 76): string {
  const indent = " ".repeat(prefix.length);
  const words = text.split(/\s+/);
  const lines: string[] = [];
  let current = prefix;

  for (const word of words) {
    if (current.length + word.length + 1 > width && current.trim() !== "") {
      lines.push(current);
      current = indent + word;
    } else {
      current += (current === prefix || current === indent ? "" : " ") + word;
    }
  }
  if (current.trim() !== "") lines.push(current);
  return lines.join("\n");
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});

import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync } from "node:fs";
import os from "node:os";
import path from "node:path";

import { scanRepository } from "../packages/engine/src/index";

/**
 * False-positive sweep.
 *
 * The failure mode this project must avoid is "someone technical pastes their
 * own repo and gets an obviously wrong answer". These are all well-known,
 * unambiguously hand-written repositories. Any authorship score above ~30 is a
 * bug to investigate, not a result.
 *
 * Clones are FULL, not shallow: a shallow clone compresses the active-day span
 * and would make `build-velocity` fire spuriously — an artifact of the test
 * method rather than a real finding.
 */

const REPOS = [
  // JS/TS
  "sindresorhus/p-limit",
  "sindresorhus/ky",
  "chalk/chalk",
  "ai/nanoid",
  "vercel/ms",
  "debug-js/debug",
  "colinhacks/zod",
  "pmndrs/zustand",
  "remeda/remeda",
  "sindresorhus/execa",
  // Python
  "pallets/click",
  "python-attrs/attrs",
  "more-itertools/more-itertools",
  "theskumar/python-dotenv",
  "jd/tenacity",
  "tkem/cachetools",
  "astanin/python-tabulate",
  "encode/httpx",
];

const ROOT =
  process.env["SWEEP_DIR"] ?? path.join(os.tmpdir(), "repo-audit-sweep");
mkdirSync(ROOT, { recursive: true });

interface Row {
  slug: string;
  tier: string;
  lang: string;
  loc: number;
  score: number;
  confidence: string;
  firing: string[];
  error?: string;
}

const rows: Row[] = [];

for (const slug of REPOS) {
  const dir = path.join(ROOT, slug.replace("/", "__"));

  if (!existsSync(dir)) {
    process.stdout.write(`cloning ${slug} … `);
    try {
      execFileSync(
        "git",
        ["clone", "--quiet", `https://github.com/${slug}.git`, dir],
        { stdio: "pipe", timeout: 240_000 },
      );
      process.stdout.write("ok\n");
    } catch (err) {
      process.stdout.write("FAILED\n");
      rows.push({
        slug,
        tier: "-",
        lang: "-",
        loc: 0,
        score: -1,
        confidence: "-",
        firing: [],
        error: String(err).slice(0, 120),
      });
      continue;
    }
  }

  try {
    const result = await scanRepository(dir, { kind: "zip", name: slug });
    const authorship = result.scores.find((s) => s.dimension === "authorship")!;

    rows.push({
      slug,
      tier: result.repo.analysisTier,
      lang: result.repo.languages[0]?.language ?? "?",
      loc: result.repo.totalLoc,
      score: authorship.score,
      confidence: authorship.confidence,
      // Only signals contributing meaningfully to the score.
      firing: authorship.signals
        .filter((s) => s.available && s.value > 0.3)
        .sort((a, b) => b.value * b.weight - a.value * a.weight)
        .map((s) => `${s.id}=${s.value.toFixed(2)}`),
    });
  } catch (err) {
    rows.push({
      slug,
      tier: "-",
      lang: "-",
      loc: 0,
      score: -1,
      confidence: "-",
      firing: [],
      error: String(err).slice(0, 160),
    });
  }
}

rows.sort((a, b) => b.score - a.score);

console.log(
  `\n${"repo".padEnd(30)} ${"tier".padEnd(11)} ${"lang".padEnd(11)} ${"loc".padStart(7)} ${"score".padStart(5)}  confidence`,
);
console.log("-".repeat(96));
for (const r of rows) {
  if (r.error) {
    console.log(`${r.slug.padEnd(30)} ERROR: ${r.error}`);
    continue;
  }
  const flag = r.score > 30 ? "  <-- INVESTIGATE" : "";
  console.log(
    `${r.slug.padEnd(30)} ${r.tier.padEnd(11)} ${r.lang.padEnd(11)} ${String(r.loc).padStart(7)} ${String(r.score).padStart(5)}  ${r.confidence}${flag}`,
  );
  if (r.firing.length > 0) console.log(`${" ".repeat(32)}${r.firing.join("  ")}`);
}

const scored = rows.filter((r) => r.score >= 0);
const suspects = scored.filter((r) => r.score > 30);
console.log(
  `\n${scored.length} scanned · median ${median(scored.map((r) => r.score))} · max ${Math.max(...scored.map((r) => r.score))} · ${suspects.length} above 30`,
);

function median(values: number[]): number {
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.floor(sorted.length / 2)] ?? 0;
}

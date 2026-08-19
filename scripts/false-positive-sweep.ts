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
  // Go and Rust. Both were history-tier until the structural index learned
  // their grammars, and their clone thresholds are the least-validated numbers
  // in the engine — these two are what validates them.
  "spf13/cobra",
  "BurntSushi/ripgrep",
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
  /** Security score. Expected 0 on every repository in this corpus. */
  security: number;
  /** Code-health score. Collected for the baseline rather than for the table. */
  health: number;
  /** Every security finding, with where it was found. See below. */
  exposures: string[];
  error?: string;
}

/**
 * The corpus is a better oracle for security than for anything else.
 *
 * For authorship it can only show a signal stays quiet on hand-written code.
 * For secrets it is close to a true-negative proof: these are among the most
 * widely-read repositories in open source, and a live credential in any of them
 * would have been found and revoked years ago. So **any** security finding here
 * is a false positive until proven otherwise, and the sweep prints all of them
 * rather than a count.
 */
const EMPTY: Pick<Row, "security" | "health" | "exposures"> = {
  security: 0,
  health: 0,
  exposures: [],
};

/**
 * `--emit-baseline` prints the corpus distribution as a pasteable constant.
 *
 * `CORPUS_BASELINE` in `@vibe/shared` tells a reader where their repository
 * lands against known hand-written code, and a hand-maintained copy of these
 * numbers would drift from the corpus it claims to describe the first time a
 * repo is added. So it is generated here, stamped with the date and the repo
 * count, and pasted.
 */
const EMIT_BASELINE = process.argv.includes("--emit-baseline");

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
        ...EMPTY,
        error: String(err).slice(0, 120),
      });
      continue;
    }
  }

  try {
    const result = await scanRepository(dir, { kind: "zip", name: slug });
    const authorship = result.scores.find((s) => s.dimension === "authorship")!;
    const security = result.scores.find((s) => s.dimension === "security");
    const health = result.scores.find((s) => s.dimension === "health");

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
      security: security?.score ?? 0,
      health: health?.score ?? 0,
      exposures: result.findings
        .filter((f) => f.dimension === "security")
        .map(
          (f) =>
            `[${f.severity}] ${f.title}` +
            (f.locations[0]
              ? ` @ ${f.locations[0].file}${f.locations[0].line ? `:${f.locations[0].line}` : ""}`
              : ""),
        ),
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
      ...EMPTY,
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
  for (const exposure of r.exposures) {
    console.log(`${" ".repeat(32)}SECURITY ${exposure}`);
  }
}

const scored = rows.filter((r) => r.score >= 0);
const suspects = scored.filter((r) => r.score > 30);
console.log(
  `\n${scored.length} scanned · median ${median(scored.map((r) => r.score))} · max ${Math.max(...scored.map((r) => r.score))} · ${suspects.length} above 30`,
);

/*
 * Reported separately and loudly. An authorship score is a judgement call that
 * moves for defensible reasons; a security finding on this corpus is a claim
 * that one of the most-read repositories in open source is leaking a
 * credential, which is a bug in us until proven otherwise.
 */
const exposed = scored.filter((r) => r.exposures.length > 0);
if (exposed.length === 0) {
  console.log(`security: clean across all ${scored.length} — no findings`);
} else {
  console.log(
    `\nsecurity: ${exposed.length} repo(s) produced findings — investigate every one`,
  );
  for (const r of exposed) {
    console.log(`  ${r.slug} (${r.security}/100)`);
    for (const exposure of r.exposures) console.log(`    ${exposure}`);
  }
}

console.log(
  `health: median ${median(scored.map((r) => r.health))} · max ${Math.max(...scored.map((r) => r.health))}`,
);

if (EMIT_BASELINE) emitBaseline(scored);

function median(values: number[]): number {
  return percentile(values, 0.5);
}

/**
 * Nearest-rank percentile.
 *
 * No interpolation: with twenty samples an interpolated p90 invents a score
 * that no repository actually got, and every number this project prints has to
 * be one it measured.
 */
function percentile(values: number[], fraction: number): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const rank = Math.ceil(fraction * sorted.length);
  return sorted[Math.min(sorted.length - 1, Math.max(0, rank - 1))]!;
}

function emitBaseline(rows: Row[]): void {
  const of = (pick: (r: Row) => number) => {
    const values = rows.map(pick);
    return {
      median: median(values),
      p90: percentile(values, 0.9),
      max: Math.max(...values),
    };
  };

  const dimensions = {
    authorship: of((r) => r.score),
    security: of((r) => r.security),
    health: of((r) => r.health),
  };

  // Emitted as source rather than JSON so it can be pasted verbatim. Reformatting
  // by hand on the way in is how a "generated" constant quietly becomes an
  // edited one.
  const lines = Object.entries(dimensions).map(
    ([name, d]) =>
      `    ${name}: { median: ${d.median}, p90: ${d.p90}, max: ${d.max} },`,
  );

  console.log(
    [
      "\n--- paste into packages/shared/src/corpus.ts ---",
      "export const CORPUS_BASELINE: CorpusBaseline = {",
      `  repos: ${rows.length},`,
      // Date, not a timestamp: the claim is "as of this sweep", and the corpus
      // does not change often enough for anything finer to mean something.
      `  measured: "${new Date().toISOString().slice(0, 10)}",`,
      "  dimensions: {",
      ...lines,
      "  },",
      "};",
    ].join("\n"),
  );
}

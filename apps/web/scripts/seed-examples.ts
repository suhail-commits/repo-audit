import { scanGitHubRepository } from "@vibe/engine";

import { createScan } from "../src/db/index";

/**
 * Seed curated example reports.
 *
 *   pnpm --filter @vibe/web seed owner/repo [owner/repo …]
 *
 * Most visitors never paste anything, so these are what they actually read —
 * and they keep the landing page useful when GitHub rate-limits us.
 *
 * ON CHOOSING REPOSITORIES: a permanent public URL asserting that someone's
 * project is AI-generated slop is indefensible, however accurate. Use
 * repositories that are explicitly AI-generated demos, your own fixtures, or
 * well-known hand-written projects — the last of which score *low*, so the page
 * reads as a compliment rather than an accusation.
 */

/** Hand-written, widely respected, and they score low. Safe to publish. */
const DEFAULT_SLUGS = [
  "sindresorhus/p-limit",
  "sindresorhus/ky",
  "colinhacks/zod",
];

async function main(): Promise<void> {
  const slugs = process.argv.slice(2).filter((a) => !a.startsWith("--"));
  const targets = slugs.length > 0 ? slugs : DEFAULT_SLUGS;

  if (!process.env["DATABASE_URL"]) {
    console.error(
      "DATABASE_URL is not set — seeded examples would land in an in-memory " +
        "store and vanish immediately.",
    );
    process.exitCode = 1;
    return;
  }
  if (!process.env["GITHUB_TOKEN"]) {
    console.warn(
      "GITHUB_TOKEN is not set. Seeding will use the 60/hour unauthenticated " +
        "limit and commit line counts will be unavailable.",
    );
  }

  for (const slug of targets) {
    process.stdout.write(`${slug} … `);
    try {
      const result = await scanGitHubRepository(slug, {
        ...(process.env["GITHUB_TOKEN"]
          ? { token: process.env["GITHUB_TOKEN"] }
          : {}),
      });

      const id = await createScan({
        slug,
        persona: "founder",
        result,
        isExample: true,
      });

      const score = result.scores[0]?.score ?? 0;
      console.log(`${score}/100  →  /scan/${id}`);
    } catch (err) {
      console.log(`failed: ${err instanceof Error ? err.message : String(err)}`);
    }
  }
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});

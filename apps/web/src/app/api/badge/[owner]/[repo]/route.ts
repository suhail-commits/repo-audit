import { authorshipBand } from "@vibe/shared";

import { latestScanFor } from "@/db";
import { renderBadge } from "@/lib/badge";
import { parseRepoSlug } from "@/lib/slug";

export const runtime = "nodejs";

/**
 * `GET /api/badge/<owner>/<repo>.svg` — the score, for a README.
 *
 * This is how both comparable products actually spread: OpenSSF Scorecard and
 * Go Report Card are each a set of checks plus a badge, and the badge is the
 * half people encounter.
 *
 * **It never triggers a scan.** An `<img>` tag is fetched by every crawler,
 * proxy and preview renderer that touches the page, and scanning on render
 * would turn one README into an unbounded queue of minute-long jobs against
 * someone else's rate limit. A repository nobody has scanned gets a badge that
 * says so.
 */
export async function GET(
  _request: Request,
  { params }: { params: Promise<{ owner: string; repo: string }> },
): Promise<Response> {
  const { owner, repo } = await params;

  // The `.svg` is decoration, so a README can carry a URL that looks like an
  // image. Both forms resolve to the same repository.
  const name = repo.replace(/\.svg$/i, "");

  /*
   * Round-tripped through the same parser the scan route uses rather than
   * concatenated. Two path segments from a URL are untrusted input, and the
   * slug ends up inside an SQL parameter and an SVG document.
   */
  const slug = parseRepoSlug(`${owner}/${name}`);
  if (!slug) return badge("vibe check", "invalid repo", 400);

  let scan;
  try {
    scan = await latestScanFor(slug);
  } catch {
    // A database that is down is not a score of zero.
    return badge("vibe check", "unavailable", 200, 0);
  }

  const score = scan?.result?.scores.find((s) => s.dimension === "authorship");
  if (!score) return badge("vibe check", "not scanned", 200, 300);

  return badge(
    "vibe check",
    `${score.score}/100 ${authorshipBand(score.score).replace("-", " ")}`,
    200,
    300,
  );
}

function badge(
  label: string,
  value: string,
  status: number,
  maxAge = 0,
): Response {
  return new Response(renderBadge({ label, value }), {
    status,
    headers: {
      "content-type": "image/svg+xml; charset=utf-8",
      /*
       * Short, and revalidating in the background. A badge that cached for a
       * day would keep showing the old number after a re-scan, which is the
       * one thing that makes a badge look broken to the person who owns it.
       */
      "cache-control": `public, max-age=0, s-maxage=${maxAge}, stale-while-revalidate=${maxAge * 4}`,
    },
  });
}

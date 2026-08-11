import { GitHubError, scanGitHubRepository } from "@vibe/engine";
import { PERSONAS, type Persona } from "@vibe/shared";

import { createScan } from "@/db";
import { parseRepoSlug } from "@/lib/slug";

export const runtime = "nodejs";
/**
 * Scans run inline rather than through a queue. Most finish in a few seconds;
 * the size gate in `scanGitHubRepository` refuses repositories large enough to
 * approach this ceiling, so a slow scan fails with an explanation rather than a
 * platform timeout.
 */
export const maxDuration = 60;

/** Repository size ceiling in KB, as GitHub reports it. */
const MAX_REPO_KB = 120_000;

export async function POST(request: Request): Promise<Response> {
  let form: FormData;
  try {
    form = await request.formData();
  } catch {
    return json({ error: "Expected a form submission" }, 400);
  }

  const persona = readPersona(form.get("persona"));
  const slug = parseRepoSlug(String(form.get("repo") ?? ""));

  if (!slug) {
    return json(
      { error: "That doesn't look like a GitHub repository. Try owner/repo." },
      400,
    );
  }

  try {
    const result = await scanGitHubRepository(slug, {
      maxSizeKb: MAX_REPO_KB,
      ...(process.env["GITHUB_TOKEN"]
        ? { token: process.env["GITHUB_TOKEN"] }
        : {}),
    });

    const id = await createScan({ slug, persona, result });
    return json({ id }, 201);
  } catch (err) {
    if (err instanceof GitHubError) {
      // These messages are written for the person who pasted the URL.
      return json({ error: err.message }, err.status === 413 ? 413 : 400);
    }
    console.error(`[scan] ${slug} failed:`, err);
    return json(
      { error: "Something went wrong analysing that repository." },
      500,
    );
  }
}

function readPersona(value: FormDataEntryValue | null): Persona {
  return typeof value === "string" && PERSONAS.includes(value as Persona)
    ? (value as Persona)
    : "founder";
}

function json(body: unknown, status: number): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

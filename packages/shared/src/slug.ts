const SLUG_RE = /^[A-Za-z0-9][\w.-]*\/[\w.-]+$/;

/**
 * Accepts the forms people actually paste: a full URL, a bare host path, an SSH
 * remote, or just `owner/repo`. Returns the normalized slug, or null.
 *
 * Rejecting here rather than at the API boundary means the user gets an
 * immediate, specific error instead of a failed scan.
 *
 * **Lives in shared because two entry points take repository input from a
 * human**, and only one of them used to be forgiving. The web form has accepted
 * a pasted GitHub URL since it was written; the CLI accepted only a bare
 * `owner/repo`, so pasting the URL straight out of the address bar — the single
 * most likely thing anyone does — was rejected as invalid. The engine's
 * `isValidSlug` is a stricter *validator* over an already-normalized slug and
 * stays where it is; this is the normalizer that runs first.
 */
export function parseRepoSlug(input: string): string | null {
  let value = input.trim();
  if (value === "") return null;

  value = value
    .replace(/^git\+/, "")
    .replace(/^https?:\/\//, "")
    .replace(/^git@github\.com:/, "")
    .replace(/^www\./, "")
    .replace(/^github\.com\//, "")
    .replace(/\.git$/, "")
    .replace(/\/+$/, "");

  // Drop anything past the repo segment: /tree/main, /issues, ?tab=…
  const segments = value.split("/").filter(Boolean);
  if (segments.length < 2) return null;
  const slug = `${segments[0]}/${segments[1]!.split(/[?#]/)[0]}`;

  if (!SLUG_RE.test(slug) || slug.includes("..")) return null;
  return slug;
}

const SLUG_RE = /^[A-Za-z0-9][\w.-]*\/[\w.-]+$/;

/**
 * Accepts the forms people actually paste: a full URL, a bare host path, an SSH
 * remote, or just `owner/repo`. Returns the normalized slug, or null.
 *
 * Rejecting here rather than at the API boundary means the user gets an
 * immediate, specific error instead of a failed scan.
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

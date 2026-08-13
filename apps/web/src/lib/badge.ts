/**
 * A README badge, drawn by hand.
 *
 * No shields.io call and no new dependency: the whole thing is two rounded
 * rectangles and two pieces of text, and this project flags dependency bloat.
 * Calling an external badge service would also put someone else's uptime in
 * front of every README that carries one.
 *
 * **Deliberately one neutral colour, never a green-to-red ramp.** The score
 * scale in the report makes the same choice for the same reason: colouring a
 * high authorship score red would assert that AI-generated code is bad, which
 * is a judgement this tool does not make. It measures; the reader judges. A
 * badge is the most quotable surface we have, so it is the last place to start
 * editorialising.
 */

/** Slate, matching the report's neutral surface rather than a status hue. */
const VALUE_BG = "#3f4a5a";
const LABEL_BG = "#2b2f36";

/**
 * Average advance width of DejaVu Sans at 11px, which is what an SVG badge
 * renders with nearly everywhere. Approximate on purpose — the padding absorbs
 * the error, and measuring properly would mean shipping font metrics.
 */
const CHAR_WIDTH = 6.6;
const PADDING = 9;

export interface BadgeInput {
  /** Left half. The question being answered. */
  label: string;
  /** Right half. The answer. */
  value: string;
}

export function renderBadge({ label, value }: BadgeInput): string {
  const labelWidth = Math.round(label.length * CHAR_WIDTH) + PADDING * 2;
  const valueWidth = Math.round(value.length * CHAR_WIDTH) + PADDING * 2;
  const total = labelWidth + valueWidth;

  return [
    `<svg xmlns="http://www.w3.org/2000/svg" width="${total}" height="20" role="img" aria-label="${escapeXml(label)}: ${escapeXml(value)}">`,
    `<title>${escapeXml(label)}: ${escapeXml(value)}</title>`,
    // Clip both halves to one rounded outline so the join in the middle stays
    // square while the outer corners are rounded.
    `<clipPath id="r"><rect width="${total}" height="20" rx="3" fill="#fff"/></clipPath>`,
    `<g clip-path="url(#r)">`,
    `<rect width="${labelWidth}" height="20" fill="${LABEL_BG}"/>`,
    `<rect x="${labelWidth}" width="${valueWidth}" height="20" fill="${VALUE_BG}"/>`,
    `</g>`,
    `<g fill="#fff" text-anchor="middle" font-family="Verdana,Geneva,DejaVu Sans,sans-serif" font-size="11">`,
    text(label, labelWidth / 2),
    text(value, labelWidth + valueWidth / 2, 600),
    `</g>`,
    `</svg>`,
  ].join("");
}

/**
 * One drop shadow behind each label, which is what makes small light text
 * legible on a mid-tone plate.
 */
function text(content: string, x: number, weight = 400): string {
  const safe = escapeXml(content);
  return (
    `<text x="${x}" y="15" fill="#010101" fill-opacity=".3">${safe}</text>` +
    `<text x="${x}" y="14" font-weight="${weight}">${safe}</text>`
  );
}

/**
 * Repository slugs come from the URL, so they reach this unvalidated.
 *
 * The badge is served as `image/svg+xml`, which browsers parse as a document —
 * an unescaped `<` in a slug would be markup, not text. Escaped before it can
 * become a hole rather than trusting the route to have filtered it.
 */
function escapeXml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}

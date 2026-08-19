/** Small text helpers shared by the report templates. */

export function plural(count: number, singular: string, pluralForm?: string): string {
  return count === 1 ? singular : (pluralForm ?? `${singular}s`);
}

export function countOf(count: number, singular: string, pluralForm?: string): string {
  return `${count.toLocaleString("en-US")} ${plural(count, singular, pluralForm)}`;
}

/** "a, b and c", truncating politely past `max`. */
export function list(items: readonly string[], max = 4): string {
  const shown = items.slice(0, max);
  const rest = items.length - shown.length;

  if (shown.length === 0) return "";

  // When the list is truncated, "a, b and c (and 4 more)" reads as though it
  // were finished. Comma-join instead and let the suffix carry the remainder.
  if (rest > 0) return `${shown.join(", ")} and ${rest} more`;

  if (shown.length === 1) return shown[0]!;
  return `${shown.slice(0, -1).join(", ")} and ${shown[shown.length - 1]}`;
}

export function percent(ratio: number): string {
  return `${Math.round(ratio * 100)}%`;
}

/**
 * How to describe a set of function names that may not be describable.
 *
 * The clone template asserted "under different names (…)" unconditionally, and
 * on a real report it produced two different kinds of nonsense: **"under
 * different names (`<anonymous>`)"** for arrow functions, which have no names to
 * differ, and **"under different names (get)"** for three methods all called
 * `get`, whose names are identical.
 *
 * Returns an empty string when there is nothing true to say, so the caller can
 * simply leave the clause out. Naming the copies is a nicety; the finding is
 * that they exist.
 */
export function namesClause(names: readonly string[]): string {
  const real = names.filter((n) => n !== "" && !n.startsWith("<"));
  const distinct = [...new Set(real)];

  if (real.length < 2) return "";
  if (distinct.length === 1) return `, all called \`${distinct[0]}\``;
  return `, under different names (${list(distinct)})`;
}

/** Minutes to a phrase a non-engineer can act on. */
export function duration(minutes: number): string {
  if (minutes < 60) return `about ${Math.max(5, Math.round(minutes / 5) * 5)} minutes`;
  const hours = minutes / 60;
  if (hours < 8) return `about ${Math.round(hours)} ${plural(Math.round(hours), "hour")}`;
  const days = Math.round(hours / 8);
  return `about ${days} ${plural(days, "day")} of developer time`;
}

/** Read a template slot as a string, tolerating missing data. */
export function str(
  data: Record<string, unknown>,
  key: string,
  fallback = "",
): string {
  const value = data[key];
  if (value === undefined || value === null) return fallback;
  return Array.isArray(value) ? list(value.map(String)) : String(value);
}

export function num(data: Record<string, unknown>, key: string, fallback = 0): number {
  const value = data[key];
  return typeof value === "number" ? value : fallback;
}

export function arr(data: Record<string, unknown>, key: string): string[] {
  const value = data[key];
  return Array.isArray(value) ? value.map(String) : [];
}

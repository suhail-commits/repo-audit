/**
 * Plural forms for the strings the engine hands to the report.
 *
 * The engine mostly emits data, but `unavailableReason`, `evidence` and
 * `warnings` are read verbatim by a human, and they were written with `(s)` —
 * "only 1 active day(s) of commits", "1 route(s) detected". A parenthesised `s`
 * is the shape of a message nobody expected to be read.
 *
 * Duplicated in spirit by `packages/rules/src/format.ts`, and deliberately not
 * shared: the dependency direction is `shared ← engine ← rules`, so the engine
 * cannot import the rules package, and moving text helpers into `shared` would
 * put report prose in the package that is supposed to hold only types.
 */

export function plural(
  count: number,
  singular: string,
  pluralForm?: string,
): string {
  return count === 1 ? singular : (pluralForm ?? `${singular}s`);
}

/** `3 commits`, `1 commit`. */
export function countOf(
  count: number,
  singular: string,
  pluralForm?: string,
): string {
  return `${count.toLocaleString("en-US")} ${plural(count, singular, pluralForm)}`;
}

/**
 * What a scan actually does, in the order it does it.
 *
 * Written once and read twice. `StartScanForm` steps through these while the
 * request is in flight, so the wait reads as progress rather than a hang; the
 * landing page walks the same list to show a visitor what they are about to
 * set off. Two copies would drift, and the landing page would end up promising
 * work the scanner does not do.
 */
export const STAGES = [
  "Fetching the repository…",
  "Reading the commit history…",
  "Parsing every source file…",
  "Looking for duplicated logic…",
  // Named now that the report leads with all three checks rather than one. A
  // wait that only mentions duplication makes the security section look like
  // something we bolted on after the fact.
  "Checking for exposed keys and open routes…",
  "Weighing the evidence…",
] as const;

/**
 * The same six steps without the ellipsis, for the landing page.
 *
 * The trailing "…" means "this is happening now", which is true inside the
 * form and false in a list of things the scanner does. Derived rather than
 * written out again so a change to `STAGES` cannot leave the two disagreeing.
 */
export const STAGE_LABELS: readonly string[] = STAGES.map((s) =>
  s.replace(/…$/, ""),
);

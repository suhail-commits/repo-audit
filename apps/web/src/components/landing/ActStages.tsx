import { STAGE_LABELS } from "@/lib/stages";

/**
 * The six things a scan actually does, in order.
 *
 * Read from `STAGE_LABELS` rather than written out here, so this list and the
 * progress line the form shows during a real scan cannot disagree. A landing
 * page that advertises a step the scanner does not run is the cheapest possible
 * way to make the whole report look invented.
 */
export function ActStages() {
  return (
    <ol className="stage-list">
      {STAGE_LABELS.map((label, i) => (
        <li className="stage-row" key={label}>
          <span className="stage-num" aria-hidden="true">
            {String(i + 1).padStart(2, "0")}
          </span>
          <span className="stage-label">{label}</span>
          <span className="stage-rule" aria-hidden="true" />
        </li>
      ))}
    </ol>
  );
}

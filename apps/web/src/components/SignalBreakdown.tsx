import type { DimensionScore } from "@vibe/shared";

/**
 * Why the score is what it is, one bar per signal.
 *
 * Bar length is the signal's **contribution in points**, not its raw value:
 * `value × weight ÷ (total available weight) × 100`. That is the actual
 * arithmetic the scorer performs, so the bars sum to the score — a reader can
 * check the total rather than take it on trust, which is the whole argument
 * this product makes about itself.
 *
 * This is one series measuring magnitude, so it is a single hue varying by
 * length. Giving each signal its own colour would cycle hues for something that
 * is not an identity encoding, and would imply the signals are unrelated
 * categories rather than parts of one sum.
 *
 * A server component: the numbers are already on the page, so the hover detail
 * rides on `title` rather than pulling a client bundle in for a tooltip.
 */
export function SignalBreakdown({ score }: { score: DimensionScore }) {
  const available = score.signals.filter((s) => s.available);
  const totalWeight = available.reduce((sum, s) => sum + s.weight, 0);

  if (score.signals.length === 0) return null;

  const rows = score.signals.map((signal) => {
    const maxPoints = totalWeight > 0 ? (signal.weight / totalWeight) * 100 : 0;
    return {
      ...signal,
      points: signal.available ? maxPoints * signal.value : 0,
      maxPoints,
    };
  });

  // Scale every track to the largest share any single signal could contribute,
  // so bar lengths are comparable across rows rather than each self-normalised.
  const scale = Math.max(...rows.map((r) => r.maxPoints), 1);

  const ordered = [...rows].sort((a, b) => {
    if (a.available !== b.available) return a.available ? -1 : 1;
    return b.points - a.points;
  });

  const measured = ordered.filter((r) => r.available).length;

  return (
    <section className="breakdown" aria-labelledby="breakdown-heading">
      <div className="section-head">
        <h3 id="breakdown-heading">How the score was reached</h3>
        <span className="meta">
          {measured} of {score.signals.length} signals measured
        </span>
      </div>

      <ol className="signal-list">
        {ordered.map((row) => (
          <li
            className={`signal${row.available ? "" : " signal-absent"}`}
            key={row.id}
            title={
              row.available
                ? `${humanize(row.id)} — value ${row.value.toFixed(2)}, weight ${row.weight}, contributing ${row.points.toFixed(1)} of ${row.maxPoints.toFixed(1)} possible points`
                : `${humanize(row.id)} — not measured: ${row.unavailableReason ?? "inputs unavailable"}`
            }
          >
            <span className="signal-name">{humanize(row.id)}</span>

            {row.available ? (
              <>
                <span className="signal-track">
                  <span
                    className="signal-fill"
                    style={{ width: `${(row.points / scale) * 100}%` }}
                  />
                </span>
                <span className="signal-points">
                  {row.points < 0.05 ? "0" : `+${row.points.toFixed(1)}`}
                </span>
              </>
            ) : (
              /*
               * Never a zero-length bar. A zero bar reads as "measured, found
               * nothing", which is the opposite of the truth and inverts the
               * invariant that a missing signal lowers confidence rather than
               * the score.
               */
              <>
                <span className="signal-absent-reason">
                  not measured — {row.unavailableReason ?? "inputs unavailable"}
                </span>
                <span className="signal-points">&mdash;</span>
              </>
            )}
          </li>
        ))}
      </ol>

      <p className="breakdown-foot">
        Points add up to the score of <strong>{score.score}</strong>. Unmeasured
        signals are excluded and their weight shared across the rest, which lowers{" "}
        <em>confidence</em> rather than the score.
      </p>
    </section>
  );
}

/** `agent-trailers` → `Agent trailers`. */
function humanize(id: string): string {
  const words = id.replace(/-/g, " ");
  return words.charAt(0).toUpperCase() + words.slice(1);
}

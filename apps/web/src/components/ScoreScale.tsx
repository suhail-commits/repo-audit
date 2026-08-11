import { bandsFor } from "@vibe/shared";

/**
 * The score, and a scale that tells the reader what the number means.
 *
 * Without this, "15 / 100" is unreadable: nothing says whether high means more
 * of the thing or less, or whether 15 is normal. The bands already drive the
 * headline sentence — drawing them just makes the same information visible.
 *
 * **The track is neutral and only the marker carries colour.** A green-to-red
 * ramp would be the wrong encoding for an ordered scale, and on the authorship
 * dimension it would assert that AI-generated code is *bad*, a judgement this
 * tool does not make. Keeping health on the identical treatment matters too:
 * two scales that look different imply the numbers work differently, and both
 * of these run the same way — higher means more of what was measured.
 */
export function ScoreScale({
  dimension,
  score,
  caption,
}: {
  /** Chooses the band words. Every scale runs low to high the same way. */
  dimension: string;
  score: number;
  caption: string;
}) {
  const bands = bandsFor(dimension);
  const position = Math.min(100, Math.max(0, score));
  const current = [...bands].reverse().find((b) => score >= b.from) ?? bands[0]!;

  return (
    <div className="scale">
      <div className="scale-head">
        <span className="score-value">{score}</span>
        <span className="score-of">/ 100</span>
        <span className="scale-caption">{caption}</span>
      </div>

      <div
        className="scale-track"
        role="img"
        aria-label={`${score} out of 100 — ${current.label}`}
      >
        {bands.map((band, i) => {
          const next = bands[i + 1];
          const width = (next ? next.from : 100) - band.from;
          return (
            <span
              className={`scale-band${band === current ? " is-current" : ""}`}
              key={band.label}
              style={{ width: `${width}%` }}
            >
              <span className="scale-band-label">{band.label}</span>
            </span>
          );
        })}
        <span className="scale-marker" style={{ left: `${position}%` }} />
      </div>
    </div>
  );
}

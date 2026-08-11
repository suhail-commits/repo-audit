import { AUTHORSHIP_BANDS, authorshipBand } from "@vibe/shared";

/**
 * The score, and a scale that tells the reader what the number means.
 *
 * Without this, "15 / 100" is unreadable: nothing says whether high means more
 * AI or less, or whether 15 is normal. The bands already drive the headline
 * sentence — drawing them just makes the same information visible.
 *
 * **The track is neutral and only the marker carries colour.** A green-to-red
 * ramp would be the wrong encoding for an ordered scale, and it would assert
 * that AI-generated code is *bad* — a judgement this tool does not make. It
 * measures; the reader decides what to think.
 */
export function ScoreScale({
  score,
  caption,
}: {
  score: number;
  caption: string;
}) {
  const current = authorshipBand(score);
  const position = Math.min(100, Math.max(0, score));

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
        aria-label={`${score} out of 100 — ${current.replace("-", " ")} to be AI-generated`}
      >
        {AUTHORSHIP_BANDS.map((band, i) => {
          const next = AUTHORSHIP_BANDS[i + 1];
          const width = (next ? next.from : 100) - band.from;
          return (
            <span
              className={`scale-band${band.band === current ? " is-current" : ""}`}
              key={band.band}
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

import { hotspotCaveat, hotspotTitle, signalLabel } from "@vibe/rules";
import type { DimensionScore, Persona } from "@vibe/shared";

/**
 * Where the file-attributable signals concentrate.
 *
 * **A ranking, not a set of scores.** Only some checks can say which file they
 * mean, so a per-directory number could never reconcile with the dimension
 * score printed above it — two numbers on one page that look comparable and are
 * not is worse than one number and an ordering. The bars carry position; no
 * figure is printed beside them, which is the whole point.
 *
 * One series measuring magnitude, so a single hue varying by length. Giving
 * each directory its own colour would cycle hues for something that is not an
 * identity encoding.
 *
 * A server component: the values are static once the scan is stored, so the
 * per-row detail rides on `title` rather than pulling in a client bundle.
 */
export function Hotspots({
  score,
  persona,
}: {
  score: DimensionScore;
  persona: Persona;
}) {
  const hotspots = score.hotspots ?? [];
  if (hotspots.length === 0) return null;

  // Counted from what actually contributed rather than written as a constant:
  // `write-once-files` is unavailable on any GitHub-sourced scan, so the same
  // repository legitimately ranks on fewer checks there than from a checkout.
  const contributing = new Set(hotspots.flatMap((h) => h.signals)).size;

  return (
    <section className="hotspots">
      <h4>{hotspotTitle(score.dimension, persona)}</h4>

      <ol className="hotspot-list">
        {hotspots.map((entry) => (
          <li className="hotspot" key={entry.path}>
            {/* A bare "." is a path, not a place. Name it. */}
            {entry.path === "." ? (
              <span className="hotspot-path hotspot-path-root">repo root</span>
            ) : (
              <code className="hotspot-path">{entry.path}</code>
            )}
            <span
              className="hotspot-track"
              title={entry.signals
                .map((id) => signalLabel(id, persona).label)
                .join(", ")}
            >
              <span
                className="hotspot-fill"
                style={{ width: `${Math.max(4, entry.intensity * 100)}%` }}
              />
            </span>
            <span className="hotspot-files">
              {entry.files} {entry.files === 1 ? "file" : "files"}
            </span>
          </li>
        ))}
      </ol>

      {/*
        Identity never depends on the bar: each row names the checks that put it
        there, so the ranking is readable without seeing the lengths at all.
      */}
      <p className="hotspot-foot">{hotspotCaveat(contributing, persona)}</p>
    </section>
  );
}

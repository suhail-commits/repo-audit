/**
 * What the tool cannot see, stated on the landing page rather than buried.
 *
 * This act deliberately does not move. After five animated ones, stillness is
 * the point — the claim being made here is candour, and animating it would
 * undercut it.
 *
 * The content is the README's "what this cannot see" section. It belongs in
 * front of a first-time visitor because the failure mode this whole project is
 * built against is someone technical pasting their own repository and getting
 * an obviously wrong answer. Saying the limits out loud first is what makes the
 * rest of the numbers worth reading.
 */
const BLIND_SPOTS = [
  {
    title: "Gitignored agent config",
    body: "We only see committed files. A CLAUDE.md that was never checked in is invisible to us.",
  },
  {
    title: "Squashed history",
    body: "Four of the signals read the commit log. Squash it and they report unavailable rather than guessing.",
  },
  {
    title: "Repositories under five commits",
    body: "Too short a history to measure commit shape or velocity. We say so instead of scoring it anyway.",
  },
  {
    title: "Anyone deliberately hiding it",
    body: "Strip the trailers, delete the config, and the tool goes quiet. It is not adversarial-proof and does not claim to be.",
  },
] as const;

export function ActBlindSpots() {
  return (
    <ul className="blindspot-grid">
      {BLIND_SPOTS.map((spot) => (
        <li className="blindspot" key={spot.title}>
          <h3>{spot.title}</h3>
          <p>{spot.body}</p>
        </li>
      ))}
    </ul>
  );
}

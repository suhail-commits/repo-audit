"use client";

import { motion, useReducedMotion, useScroll, useTransform } from "motion/react";
import { useRef, type CSSProperties, type ReactNode } from "react";

/**
 * One full-viewport scene of the landing page.
 *
 * Each act owns a tall rail of scroll and pins a stage inside it, so the
 * viewport holds still while scroll drives the animation. The scene arrives
 * from depth, settles, then continues past the camera as the next one arrives
 * behind it — real perspective rather than a scale, because a card that grows
 * reads as a card growing and a card on a Z axis reads as a card approaching.
 *
 * Six values are published to CSS every frame:
 *
 * | var | what it drives |
 * |---|---|
 * | `--z`    | translateZ in px — the approach and the departure |
 * | `--o`    | opacity — faded at both ends so scenes cross-dissolve |
 * | `--s`    | scale — a touch of overshoot as it passes |
 * | `--blur` | depth of field; nothing distant is ever sharp |
 * | `--head` | depth parallax for the heading, which trails the surface |
 * | `--p`    | 0 to 1 across the settled middle, for the surface to draw itself |
 *
 * **`--p` deliberately runs only across the hold**, not across the whole rail.
 * Mapping it end to end would start the bars growing while the scene was still
 * arriving and finish them as it left, so the completed state would never
 * actually be seen at rest.
 *
 * `children` stays a server component. Passing the real `ModuleMap`,
 * `SignalBreakdown`, `ScoreScale` and `Priorities` down rather than importing
 * them here keeps them, and `@vibe/rules` behind them, out of the client
 * bundle — while still letting this wrapper animate their internals, because
 * the animation lives in CSS reading the variables above.
 */
export function Act({
  index,
  title,
  lede,
  surface = "plain",
  children,
}: {
  index: string;
  title: string;
  lede: string;
  surface?: "plain" | "stages" | "graph" | "signals" | "score" | "priorities";
  children?: ReactNode;
}) {
  const still = useReducedMotion();
  const rail = useRef<HTMLDivElement>(null);

  const { scrollYProgress } = useScroll({
    target: rail,
    offset: ["start start", "end end"],
  });

  /*
   * Four-point curves: arrive, hold, hold, depart.
   *
   * The hold is the widest segment on purpose. A scene that is only ever
   * moving is a scene nobody can read, and the point of pinning is to buy
   * still time in the middle, not to animate continuously for its own sake.
   *
   * **The 0.31 / 0.69 breakpoints are the CSS overlap expressed as a fraction**
   * — scenes are pulled 100vh over each other out of a 320vh rail, so a scene
   * arrives across exactly the span where the previous one is leaving. Change
   * `--scene-overlap` in landing.css without changing these and the two stop
   * meeting, which reopens the blank frame between every act that this
   * replaced: each scene used to finish fading out a full viewport before the
   * next began to arrive.
   */
  const z = useTransform(scrollYProgress, [0, 0.31, 0.69, 1], [-1600, 0, 0, 480]);
  const o = useTransform(scrollYProgress, [0, 0.3, 0.7, 1], [0, 1, 1, 0]);
  const s = useTransform(scrollYProgress, [0, 0.31, 0.69, 1], [0.86, 1, 1, 1.08]);
  const blur = useTransform(scrollYProgress, [0, 0.31, 0.69, 1], [16, 0, 0, 12]);
  /*
   * The heading trails the surface in *depth*, not in height.
   *
   * This was a translateY running +70 to -70, which made every scene rise from
   * below the fold — the content read as coming up from the bottom rather than
   * out of the middle. A scale run against the container's own scale keeps the
   * two planes separable without giving the composition a direction.
   */
  const head = useTransform(
    scrollYProgress,
    [0, 0.31, 0.69, 1],
    [0.92, 1, 1, 1.03],
  );
  const p = useTransform(scrollYProgress, [0.33, 0.62], [0, 1], { clamp: true });

  /*
   * With the preference set the scene is handed its finished state and never
   * moves. The reduced-motion block in globals.css cannot cover this on its
   * own — it zeroes transition durations, and a scroll-linked transform has no
   * duration to zero.
   */
  const vars = still
    ? { "--z": 0, "--o": 1, "--s": 1, "--blur": 0, "--head": 1, "--p": 1 }
    : { "--z": z, "--o": o, "--s": s, "--blur": blur, "--head": head, "--p": p };

  return (
    <section className="scene">
      <div className="scene-rail" ref={rail}>
        <div className="scene-stage">
          <motion.div
            className="scene-depth"
            data-surface={surface}
            style={vars as unknown as CSSProperties}
          >
            <header className="act-head">
              <span className="act-index" aria-hidden="true">
                {index}
              </span>
              <h2 className="act-title">{title}</h2>
              <p className="act-lede">{lede}</p>
            </header>

            {children ? <div className="act-surface">{children}</div> : null}
          </motion.div>
        </div>
      </div>
    </section>
  );
}

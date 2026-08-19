"use client";

import { motion, useReducedMotion, useScroll, useTransform } from "motion/react";
import { useRef, type CSSProperties, type ReactNode } from "react";

import { Scramble } from "@/components/landing/Scramble";

/**
 * The opening scene: one claim at the largest type on the site, and the input.
 *
 * **The input lives here rather than at the end.** A film that has to be
 * watched before the product can be used is a film nobody finishes; anyone who
 * already knows what this is pastes a repository from the first screen without
 * seeing a frame of the rest.
 *
 * Which is also why this scene departs rather than arrives — it is already on
 * screen when the page loads, so the only motion it needs is the way it leaves.
 * Bringing it in from depth would put an animation between the reader and the
 * one control on the page.
 */
export function Hero({ children }: { children: ReactNode }) {
  const still = useReducedMotion();
  const rail = useRef<HTMLDivElement>(null);

  const { scrollYProgress } = useScroll({
    target: rail,
    offset: ["start start", "end end"],
  });

  /*
   * Held still, then handed over. The hero does not begin leaving until half
   * its rail is gone, and finishes exactly as the first act finishes arriving
   * over the top of it — the two rails overlap by design, so this curve and
   * `--scene-overlap` in landing.css have to agree or a blank frame opens up
   * between them.
   */
  const z = useTransform(scrollYProgress, [0.5, 1], [0, 620]);
  const o = useTransform(scrollYProgress, [0.5, 1], [1, 0]);
  const s = useTransform(scrollYProgress, [0.5, 1], [1, 1.12]);
  const blur = useTransform(scrollYProgress, [0.5, 1], [0, 14]);

  const vars = still
    ? { "--z": 0, "--o": 1, "--s": 1, "--blur": 0 }
    : { "--z": z, "--o": o, "--s": s, "--blur": blur };

  return (
    <section className="scene scene-hero">
      <div className="scene-rail scene-rail-hero" ref={rail}>
        <div className="scene-stage">
          <motion.div
            className="scene-depth"
            style={vars as unknown as CSSProperties}
          >
            <p className="hero-eyebrow">
              Static analysis &middot; no model is asked for an opinion
            </p>

            <h1 className="hero-display">
              How much of your codebase did{" "}
              <Scramble className="hero-scramble" text="AI actually write?" />
            </h1>

            <p className="hero-sub">
              Paste a public GitHub repository. One scan, three answers &mdash;
              how much of it looks AI-generated, what it exposes, and what it
              will cost to keep working on.
            </p>

            <div className="hero-form">{children}</div>

            <p className="hero-cue" aria-hidden="true">
              <span className="hero-cue-rule" />
              or scroll to watch it work
            </p>
          </motion.div>
        </div>
      </div>
    </section>
  );
}

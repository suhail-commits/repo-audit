"use client";

import { motion, useScroll, useSpring } from "motion/react";

/**
 * How far through the film you are.
 *
 * The landing page hides its scrollbar, which is what lets the scenes read as
 * full-bleed rather than as a document. Hiding it without replacing it would
 * take away the only thing telling a reader how much is left — so this puts
 * that back deliberately, as a hairline rule rather than as furniture.
 *
 * Sprung rather than linear. Bound straight to scroll it jitters on a trackpad
 * at exactly the moment the eye is drawn to it.
 *
 * **Hidden by CSS under reduced motion rather than by returning null.** The
 * first version read `useReducedMotion()` and bailed out early, which cannot
 * work: the server has no media query to read, so it rendered nothing while the
 * client rendered the rail, and React reported a hydration mismatch on every
 * load. A value only the browser knows must not decide whether an element
 * exists — only how it looks.
 */
export function ScrollRail() {
  const { scrollYProgress } = useScroll();
  const width = useSpring(scrollYProgress, {
    stiffness: 240,
    damping: 40,
    restDelta: 0.001,
  });

  return (
    <motion.div
      className="scroll-rail"
      style={{ scaleX: width }}
      aria-hidden="true"
    />
  );
}

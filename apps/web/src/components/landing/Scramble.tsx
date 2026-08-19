"use client";

import { useReducedMotion } from "motion/react";
import { useEffect, useRef, useState } from "react";

/** Glyphs the decode cycles through. Monospace-ish shapes, no letters that
 *  spell anything on the way past. */
const GLYPHS = "#$%&/<>[]{}=+*_·░▒▓";

/**
 * A phrase that resolves out of noise, one character at a time.
 *
 * Borrowed from CodeRabbit's headline, and it earns its place here for a reason
 * beyond decoration: the whole product is about resolving something illegible —
 * a repository you did not write — into a statement you can act on. The
 * headline doing the same thing is the argument in miniature.
 *
 * **The real text is always in the accessibility tree.** The animated glyphs
 * are `aria-hidden`, and the resolved phrase sits in an `aria-label`, so a
 * screen reader never hears the noise. With reduced motion requested there is
 * no noise at all — the phrase renders resolved and nothing moves.
 */
export function Scramble({
  text,
  /** Held before the decode starts, so the line is readable as it arrives. */
  delayMs = 400,
  className,
}: {
  text: string;
  delayMs?: number;
  className?: string;
}) {
  const still = useReducedMotion();
  const [shown, setShown] = useState(() => (still ? text : ""));
  const frame = useRef<ReturnType<typeof setInterval> | null>(null);

  useEffect(() => {
    if (still) {
      setShown(text);
      return;
    }

    let revealed = 0;
    let tick = 0;

    const start = setTimeout(() => {
      frame.current = setInterval(() => {
        tick += 1;
        // Two frames of noise per character resolved. Faster than this and the
        // effect reads as a glitch; slower and the reader waits on a headline.
        if (tick % 2 === 0) revealed += 1;

        if (revealed > text.length) {
          if (frame.current) clearInterval(frame.current);
          setShown(text);
          return;
        }

        const settled = text.slice(0, revealed);
        const noise = text
          .slice(revealed)
          .split("")
          .map((ch) =>
            // Spaces stay spaces. Scrambling them collapses the word shapes and
            // the line jitters sideways while it resolves.
            ch === " " ? " " : GLYPHS[Math.floor(Math.random() * GLYPHS.length)],
          )
          .join("");

        setShown(settled + noise);
      }, 40);
    }, delayMs);

    return () => {
      clearTimeout(start);
      if (frame.current) clearInterval(frame.current);
    };
  }, [text, delayMs, still]);

  return (
    <span className={className} aria-label={text}>
      <span aria-hidden="true" className="scramble-glyphs">
        {shown}
      </span>
    </span>
  );
}

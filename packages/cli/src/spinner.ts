import type { ScanStage } from "@vibe/engine";

import type { Io } from "./io";
import { dim } from "./term";

/**
 * A spinner that reports what the scan is actually doing.
 *
 * Fed by the engine's `onProgress`, which fires at nine real phase boundaries.
 * It shows the stage the engine announced and the elapsed time, and **never a
 * percentage** — there is no item count behind any stage, so a bar would be a
 * number invented to look reassuring. That fiction is already recorded in this
 * project as a mistake: the web app advances six stage strings on a 2.2-second
 * timer regardless of what the scan is doing, and reports "Weighing the
 * evidence" while the tarball is still downloading.
 *
 * Writes to **stderr**, so `repo-audit . --json > out.json` still produces a
 * clean file. Falls back to one line per stage when stderr is not a terminal,
 * which is exactly what the CLI printed before this existed.
 */

const FRAMES = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];
const INTERVAL_MS = 80;

const ESC = String.fromCharCode(27);
const HIDE_CURSOR = `${ESC}[?25l`;
const SHOW_CURSOR = `${ESC}[?25h`;
const CLEAR_LINE = `${ESC}[2K`;

export interface Spinner {
  /** Hand this to `scanRepository` as `onProgress`. */
  onProgress: (stage: ScanStage) => void;
  /** Stop and erase. Safe to call more than once. */
  stop: () => void;
  /** Stop, erase, and leave one summary line behind. */
  succeed: (message: string) => void;
}

export function createSpinner(io: Io, enabled: boolean): Spinner {
  const live = enabled && Boolean(io.stderr.isTTY);
  const started = Date.now();

  let label = "Starting";
  let frame = 0;
  let timer: ReturnType<typeof setInterval> | undefined;
  let stopped = false;

  const elapsed = (): string => `${((Date.now() - started) / 1000).toFixed(1)}s`;

  const draw = (): void => {
    frame = (frame + 1) % FRAMES.length;
    io.stderr.write(`\r${CLEAR_LINE}  ${FRAMES[frame]} ${label} ${dim(elapsed())}`);
  };

  const erase = (): void => {
    io.stderr.write(`\r${CLEAR_LINE}`);
  };

  const teardown = (): void => {
    if (stopped) return;
    stopped = true;
    if (timer) clearInterval(timer);
    if (live) {
      erase();
      io.stderr.write(SHOW_CURSOR);
    }
    process.off("SIGINT", teardown);
  };

  if (live) {
    io.stderr.write(HIDE_CURSOR);
    /*
     * `unref` so a spinner can never be the reason the process stays alive. If
     * the scan settles and something forgets to stop this, Node should still
     * exit rather than hang on a timer nobody is watching.
     */
    timer = setInterval(draw, INTERVAL_MS);
    timer.unref?.();
    // The cursor is hidden. Leaving it hidden after Ctrl+C is a worse outcome
    // than any incomplete scan, so restore before the default handler runs.
    process.on("SIGINT", teardown);
  }

  return {
    onProgress: (stage: ScanStage) => {
      label = stage.label;
      if (live) draw();
      // Not a terminal: one line per stage, never erased. Identical to what the
      // CLI printed before the spinner existed, so piping behaviour is unchanged.
      else if (enabled) io.stderr.write(`${dim("  · " + stage.label)}\n`);
    },
    stop: teardown,
    succeed: (message: string) => {
      const took = elapsed();
      teardown();
      if (enabled) io.stderr.write(`${dim(`  ${message} in ${took}`)}\n`);
    },
  };
}

import type { Readable, Writable } from "node:stream";

/**
 * Everything the CLI is allowed to touch about the outside world.
 *
 * `run()` used to buffer all its output into a string and hand it back, and
 * `index.ts` documented itself as the only place that touches `process`. That
 * is a good rule and it is what made the renderers testable — but it cannot
 * survive interactivity, which has to read a keystroke and repaint a line
 * *during* execution rather than after it. The progress hook already broke the
 * rule quietly; this makes the exception explicit and gives it a seam.
 *
 * The rule that replaces it: nothing below `index.ts` reads `process` directly,
 * it reads this. Tests pass fakes and can therefore drive a prompt, assert on
 * what was drawn, and — the part that matters — prove that nothing prompts when
 * there is no terminal attached.
 */
export interface Io {
  stdin: Readable & { isTTY?: boolean; setRawMode?: (mode: boolean) => void };
  stdout: Writable & { isTTY?: boolean; columns?: number };
  stderr: Writable & { isTTY?: boolean };
  /** Environment, read for `NO_COLOR`, `COLUMNS` and `GITHUB_TOKEN`. */
  env: Record<string, string | undefined>;
}

export function realIo(): Io {
  return {
    stdin: process.stdin,
    stdout: process.stdout,
    stderr: process.stderr,
    env: process.env,
  };
}

/**
 * Whether this invocation can hold a conversation.
 *
 * Both directions are required and the asymmetry matters: output could be a
 * terminal while input is a pipe (`echo x | repo-audit`), and prompting there
 * would consume the piped bytes as answers. Input could be a terminal while
 * output is redirected (`repo-audit > out.txt`), and prompting there paints
 * questions into the file the user is trying to keep.
 *
 * **A CLI that prompts with no terminal attached hangs forever with no output**,
 * which is the worst failure a tool can have in a pipeline — so this is the
 * gate on every interactive path, and it fails closed.
 */
export function isInteractive(io: Io): boolean {
  return Boolean(io.stdin.isTTY && io.stdout.isTTY);
}

import { emitKeypressEvents } from "node:readline";
import { createInterface } from "node:readline/promises";

import type { Io } from "./io";
import { accent, bold, dim, visibleLength } from "./term";

/**
 * Prompts, hand-rolled against Node's own `readline`.
 *
 * No dependency, for the reason `term.ts` gives: everything needed is in the
 * standard library at the Node version `oxc-parser` already forces, and this is
 * a tool that reports dependency bloat as a finding.
 *
 * **The unglamorous half is the whole risk.** Raw mode is process-global state:
 * enable it, crash, and the user's shell is left unable to echo what they type
 * until they run `reset`. Every path through here restores it — success, throw,
 * and Ctrl+C — which is why the teardown is a `finally` and a signal handler
 * rather than a line at the end of the happy path.
 */

/** What `readline`'s keypress event carries, narrowed to what is used here. */
export interface Key {
  name?: string;
  ctrl?: boolean;
}

type KeyHandler = (str: string, key: Key | undefined) => void;

/** Thrown when the user aborts. Carries no message; the caller decides. */
export class PromptCancelled extends Error {
  constructor() {
    super("cancelled");
    this.name = "PromptCancelled";
  }
}

const ESC = String.fromCharCode(27);
const HIDE_CURSOR = `${ESC}[?25l`;
const SHOW_CURSOR = `${ESC}[?25h`;
const CLEAR_LINE = `${ESC}[2K`;
const LINE_START = "\r";

/** Move the cursor up `n` lines. Zero is a no-op, not `[0A`. */
function up(n: number): string {
  return n > 0 ? `${ESC}[${n}A` : "";
}

/**
 * A single line of free text, with a default accepted on Enter.
 *
 * `readline/promises` handles line editing, history and backspace for free —
 * there is no reason to reimplement a text field, and doing so is how prompt
 * libraries end up with their own bug trackers.
 */
export async function text(
  io: Io,
  question: string,
  fallback?: string,
): Promise<string> {
  const rl = createInterface({
    input: io.stdin,
    output: io.stdout,
    terminal: true,
  });

  try {
    const suffix = fallback ? dim(` (${fallback})`) : "";
    const answer = await rl.question(`${accent("?")} ${bold(question)}${suffix}\n${accent("›")} `);
    const value = answer.trim();
    if (value) return value;
    if (fallback) return fallback;
    throw new PromptCancelled();
  } finally {
    // Closing releases the raw mode readline put the terminal into. Without
    // this the shell stops echoing after the CLI exits.
    rl.close();
  }
}

export interface Choice {
  value: string;
  /** Shown to the right in dim text. Optional. */
  hint?: string;
}

/**
 * An arrow-key menu.
 *
 * Renders every option, repaints in place on each keypress, and leaves a single
 * summary line behind when it resolves — so a transcript of the session reads
 * as a conversation rather than as forty redraws of the same list.
 *
 * Long lists are windowed rather than scrolled: a repository with two hundred
 * branches must not paint two hundred lines into a terminal that holds forty.
 */
export async function select(
  io: Io,
  question: string,
  choices: Choice[],
  initial = 0,
): Promise<string> {
  if (choices.length === 0) throw new PromptCancelled();
  if (choices.length === 1) {
    const only = choices[0]!.value;
    io.stdout.write(`${accent("?")} ${bold(question)} ${accent(only)}\n`);
    return only;
  }

  const WINDOW = 8;
  let index = Math.max(0, Math.min(initial, choices.length - 1));
  let painted = 0;

  const visible = (): { slice: Choice[]; offset: number } => {
    if (choices.length <= WINDOW) return { slice: choices, offset: 0 };
    // Keep the cursor roughly centred, clamped at both ends.
    const half = Math.floor(WINDOW / 2);
    const offset = Math.max(0, Math.min(index - half, choices.length - WINDOW));
    return { slice: choices.slice(offset, offset + WINDOW), offset };
  };

  const paint = (): void => {
    const { slice, offset } = visible();
    const lines: string[] = [`${accent("?")} ${bold(question)}`];

    slice.forEach((choice, i) => {
      const real = offset + i;
      const selected = real === index;
      const marker = selected ? accent("❯") : " ";
      const label = selected ? accent(choice.value) : choice.value;
      const hint = choice.hint ? dim(`  ${choice.hint}`) : "";
      lines.push(`${marker} ${label}${hint}`);
    });

    if (choices.length > WINDOW) {
      lines.push(dim(`  ${index + 1} of ${choices.length} — ↑↓ to move, Enter to choose`));
    }

    // Repaint over the previous frame rather than appending a new one.
    const rewind = painted > 0 ? up(painted) : "";
    const body = lines.map((l) => `${CLEAR_LINE}${l}`).join("\n");
    io.stdout.write(`${rewind}${LINE_START}${body}\n`);
    painted = lines.length;
  };

  return withRawMode(io, (resolve, reject) => {
    paint();

    return (_str, key) => {
      if (!key) return;

      if (key.ctrl && key.name === "c") return reject(new PromptCancelled());
      if (key.name === "escape") return reject(new PromptCancelled());

      if (key.name === "up" || key.name === "k") {
        index = (index - 1 + choices.length) % choices.length;
        return paint();
      }
      if (key.name === "down" || key.name === "j") {
        index = (index + 1) % choices.length;
        return paint();
      }
      if (key.name === "return" || key.name === "enter") {
        // Collapse the menu to one line recording what was chosen.
        const chosen = choices[index]!.value;
        io.stdout.write(`${up(painted)}${LINE_START}${CLEAR_LINE}`);
        for (let i = 1; i < painted; i++) {
          io.stdout.write(`${ESC}[1B${CLEAR_LINE}`);
        }
        io.stdout.write(`${up(painted - 1)}${LINE_START}`);
        io.stdout.write(`${accent("?")} ${bold(question)} ${accent(chosen)}\n`);
        return resolve(chosen);
      }
    };
  });
}

/**
 * Run a keypress-driven prompt with raw mode guaranteed to be restored.
 *
 * The teardown is the point. It runs on resolve, on reject, on Ctrl+C and on
 * `SIGINT` — because leaving a terminal in raw mode with a hidden cursor is a
 * worse outcome than any wrong answer this tool could give.
 */
function withRawMode(
  io: Io,
  register: (
    resolve: (value: string) => void,
    reject: (err: Error) => void,
  ) => KeyHandler,
): Promise<string> {
  return new Promise<string>((resolve, reject) => {
    const stdin = io.stdin;
    emitKeypressEvents(stdin);

    let done = false;
    let onKey: KeyHandler | undefined;

    const restore = (): void => {
      if (done) return;
      done = true;
      if (onKey) stdin.off("keypress", onKey);
      stdin.setRawMode?.(false);
      stdin.pause();
      process.off("SIGINT", onSigint);
      io.stdout.write(SHOW_CURSOR);
    };

    function onSigint(): void {
      restore();
      reject(new PromptCancelled());
    }

    const settleResolve = (value: string): void => {
      restore();
      resolve(value);
    };
    const settleReject = (err: Error): void => {
      restore();
      reject(err);
    };

    stdin.setRawMode?.(true);
    stdin.resume();
    io.stdout.write(HIDE_CURSOR);
    process.on("SIGINT", onSigint);

    onKey = register(settleResolve, settleReject);
    stdin.on("keypress", onKey);
  });
}

/** A one-line heading above a group of prompts. */
export function intro(io: Io, title: string): void {
  io.stdout.write(`\n${bold(title)}\n\n`);
}

/** The equivalent command, so the wizard teaches the non-interactive form. */
export function echoCommand(io: Io, command: string): void {
  const label = "equivalent:";
  io.stdout.write(
    `\n${dim(label)} ${dim(command)}\n${dim("─".repeat(Math.min(visibleLength(label) + command.length + 1, 76)))}\n`,
  );
}

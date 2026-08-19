import { styleText } from "node:util";

/**
 * The terminal primitives, such as they are.
 *
 * Everything here is hand-rolled against `node:util`, because Node 22.12 —
 * which this package requires anyway for `oxc-parser` — ships `styleText`, and
 * `styleText` already does the two things a colour library is usually added
 * for: it honours `NO_COLOR`/`FORCE_COLOR` and it detects whether the stream is
 * a TTY. A dependency would buy nothing, in a tool that reports dependency
 * bloat as a finding.
 *
 * The one thing it does not do is let a `--no-color` flag turn colour off, so
 * that is the single piece of state this module holds.
 */

let enabled = true;

/** Called once from argument parsing. */
export function setColor(on: boolean): void {
  enabled = on;
}

type Style = Parameters<typeof styleText>[0];

function paint(style: Style, text: string): string {
  if (!enabled) return text;
  // `styleText` still returns plain text when the stream is not a TTY or
  // NO_COLOR is set, so this is a narrowing of its decision, never a widening.
  return styleText(style, text, { stream: process.stdout });
}

export const dim = (t: string) => paint("dim", t);
export const bold = (t: string) => paint("bold", t);
export const accent = (t: string) => paint("cyan", t);
export const warn = (t: string) => paint("yellow", t);
export const alarm = (t: string) => paint("red", t);

/**
 * Usable width, clamped.
 *
 * `process.stdout.columns` is `undefined` when output is piped to a file or
 * another process, which is exactly when a hard-wrapped report is most likely
 * to be read later — so the fallback is a readable prose width rather than
 * something arbitrary. The upper clamp exists because a maximised terminal on a
 * wide monitor produces lines nobody can track back to the left margin.
 */
export function width(): number {
  // `COLUMNS` first: `process.stdout.columns` is undefined whenever output is
  // piped, which is exactly when someone wants to choose the width themselves
  // — and it is the only way to exercise narrow rendering from a test.
  const fromEnv = Number.parseInt(process.env["COLUMNS"] ?? "", 10);
  const raw = Number.isFinite(fromEnv) && fromEnv > 0 ? fromEnv : process.stdout.columns;
  if (!raw || Number.isNaN(raw)) return 80;
  return Math.max(48, Math.min(raw - 2, 100));
}

/** Soft-wrap to the terminal width, preserving an indent under the prefix. */
export function wrap(text: string, prefix = "  ", cols = width()): string {
  const indent = " ".repeat(visibleLength(prefix));
  const words = text.split(/\s+/).filter(Boolean);
  const lines: string[] = [];
  let current = prefix;

  for (const word of words) {
    const started = current === prefix || current === indent;
    if (!started && visibleLength(current) + word.length + 1 > cols) {
      lines.push(current);
      current = indent + word;
    } else {
      current += (started ? "" : " ") + word;
    }
  }
  if (current.trim() !== "") lines.push(current);
  return lines.join("\n");
}

/**
 * Length ignoring ANSI escapes.
 *
 * Padding and wrapping both measure strings that may already be coloured, and
 * counting the escape bytes would push every styled row out of alignment by
 * about nine invisible characters.
 */
const ESC = String.fromCharCode(27);
const ANSI = new RegExp(ESC + String.raw`\[[0-9;]*m`, "g");

export function visibleLength(text: string): number {
  return text.replace(ANSI, "").length;
}

/** Pad to a visible width, so coloured cells still line up. */
export function pad(text: string, to: number): string {
  const short = to - visibleLength(text);
  return short > 0 ? text + " ".repeat(short) : text;
}

/**
 * A horizontal bar.
 *
 * Drawn with block characters rather than `#`, and with the empty portion
 * rendered as a dimmed track rather than left blank — a bare bar gives the eye
 * nothing to measure short values against.
 */
export function bar(fraction: number, cells: number): string {
  const clamped = Math.max(0, Math.min(1, fraction));
  const filled = Math.round(clamped * cells);
  return accent("█".repeat(filled)) + dim("─".repeat(cells - filled));
}

export function rule(cols = width()): string {
  return dim("─".repeat(cols));
}

/** Right-align a number in a fixed column. */
export function padStart(text: string, to: number): string {
  const short = to - visibleLength(text);
  return short > 0 ? " ".repeat(short) + text : text;
}

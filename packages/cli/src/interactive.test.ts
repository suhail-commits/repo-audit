import { PassThrough } from "node:stream";
import { describe, expect, it } from "vitest";

import { isInteractive, type Io } from "./io";
import { select } from "./prompt";
import { createSpinner } from "./spinner";
import { run } from "./main";
import { runWizard } from "./wizard";

/*
 * The interactive surface, tested through the I/O port rather than the real
 * `process`. The rule these all exist to defend: **a CLI that prompts with no
 * terminal attached hangs forever with no output.** That is the worst failure a
 * tool can have inside a pipeline, and `pnpm scan .` is on this project's commit
 * gate — so a regression here would wedge the gate itself.
 */

const ESC = String.fromCharCode(27);
const ANSI = new RegExp(ESC + String.raw`\[[0-9;?]*[a-zA-Z]`, "g");
const ARROW_DOWN = `${ESC}[B`;
const ENTER = "\r";

interface Fake extends Io {
  out: () => string;
  err: () => string;
}

function fakeIo(
  opts: { stdinTTY?: boolean; stdoutTTY?: boolean; stderrTTY?: boolean } = {},
): Fake {
  let out = "";
  let err = "";

  const stdout = new PassThrough() as unknown as Io["stdout"];
  const stderr = new PassThrough() as unknown as Io["stderr"];
  const stdin = new PassThrough() as unknown as Io["stdin"];

  (stdout as unknown as PassThrough).on("data", (c: Buffer) => (out += c.toString()));
  (stderr as unknown as PassThrough).on("data", (c: Buffer) => (err += c.toString()));

  stdin.isTTY = opts.stdinTTY ?? false;
  stdout.isTTY = opts.stdoutTTY ?? false;
  stderr.isTTY = opts.stderrTTY ?? false;
  stdin.setRawMode = () => undefined;

  return { stdin, stdout, stderr, env: {}, out: () => out, err: () => err };
}

/** A fake terminal that can be typed into. */
function terminal() {
  let out = "";
  const stdout = new PassThrough() as unknown as Io["stdout"];
  const stdin = new PassThrough() as unknown as Io["stdin"];
  (stdout as unknown as PassThrough).on("data", (c: Buffer) => (out += c.toString()));
  stdin.isTTY = true;
  stdout.isTTY = true;
  stdin.setRawMode = () => undefined;

  return {
    io: { stdin, stdout, stderr: stdout, env: {} } as Io,
    type: (s: string) => (stdin as unknown as PassThrough).write(s),
    seen: () => out.replace(ANSI, ""),
  };
}

describe("isInteractive", () => {
  it("requires a terminal on both ends", () => {
    expect(isInteractive(fakeIo({ stdinTTY: true, stdoutTTY: true }))).toBe(true);
    // Output redirected: prompting would paint questions into the user's file.
    expect(isInteractive(fakeIo({ stdinTTY: true, stdoutTTY: false }))).toBe(false);
    // Input piped: prompting would consume the piped bytes as answers.
    expect(isInteractive(fakeIo({ stdinTTY: false, stdoutTTY: true }))).toBe(false);
    expect(isInteractive(fakeIo())).toBe(false);
  });
});

describe("run, without a terminal", () => {
  it("refuses instead of prompting when nothing was named", async () => {
    // The load-bearing test. If this ever prompts, `repo-audit | cat` hangs
    // with no output and no way to know why.
    const io = fakeIo();
    const result = await run([], io);
    expect(result.exitCode).toBe(2);
    expect(result.stderr).toContain("Nothing to scan");
  });

  it("never enters the wizard when a repository was named", async () => {
    // `pnpm scan .` passes a positional, which is what keeps the commit gate
    // safe even when it runs in a terminal.
    const io = fakeIo({ stdinTTY: true, stdoutTTY: true });
    const result = await run(["--persona", "nonsense", "."], io);
    expect(result.exitCode).toBe(2);
    expect(result.stderr).toContain("Unknown persona");
  });

  it("accepts --branch as a flag", async () => {
    const io = fakeIo();
    const result = await run(["--branch", "develop", "--persona", "nope", "."], io);
    // Rejected on the persona, not on the flag — which proves --branch parsed.
    expect(result.stderr).toContain("Unknown persona");
    expect(result.stderr).not.toContain("branch");
  });
});

describe("spinner", () => {
  it("prints one line per stage when stderr is not a terminal", async () => {
    // Identical to what the CLI printed before the spinner existed, so piping
    // behaviour is unchanged.
    const io = fakeIo({ stderrTTY: false });
    const spinner = createSpinner(io, true);
    spinner.onProgress({ id: "reading", label: "Reading every file" });
    spinner.onProgress({ id: "parsing", label: "Parsing JavaScript and TypeScript" });
    spinner.stop();

    await new Promise((r) => setImmediate(r));
    expect(io.err()).toContain("Reading every file");
    expect(io.err()).toContain("Parsing JavaScript and TypeScript");
    expect(io.err()).not.toContain(`${ESC}[?25l`);
  });

  it("hides the cursor on a terminal and restores it on stop", async () => {
    // Leaving a terminal with a hidden cursor is a worse outcome than any
    // incomplete scan, so the restore is asserted rather than assumed.
    const io = fakeIo({ stderrTTY: true });
    const spinner = createSpinner(io, true);
    spinner.onProgress({ id: "reading", label: "Reading every file" });
    spinner.stop();

    await new Promise((r) => setImmediate(r));
    expect(io.err()).toContain(`${ESC}[?25l`);
    expect(io.err()).toContain(`${ESC}[?25h`);
  });

  it("writes nothing at all when quiet", async () => {
    // `--json` and `--mermaid` must produce a clean stream.
    const io = fakeIo({ stderrTTY: true });
    const spinner = createSpinner(io, false);
    spinner.onProgress({ id: "reading", label: "Reading every file" });
    spinner.succeed("scanned");

    await new Promise((r) => setImmediate(r));
    expect(io.err()).toBe("");
  });

  it("is safe to stop more than once", async () => {
    const io = fakeIo({ stderrTTY: true });
    const spinner = createSpinner(io, true);
    spinner.stop();
    spinner.stop();
    spinner.succeed("scanned");
    await new Promise((r) => setImmediate(r));
    expect(io.err()).not.toContain("undefined");
  });
});

describe("select", () => {
  it("moves with the arrow keys and chooses on Enter", async () => {
    const t = terminal();
    const chosen = select(t.io, "Which branch?", [
      { value: "main", hint: "default" },
      { value: "next" },
      { value: "v2" },
    ]);
    setTimeout(() => {
      t.type(ARROW_DOWN);
      t.type(ARROW_DOWN);
      t.type(ENTER);
    }, 40);
    expect(await chosen).toBe("v2");
    // Collapsed to one line recording the answer, not forty redraws.
    expect(t.seen().trim().split("\n").at(-1)).toContain("Which branch? v2");
  }, 20000);

  it("does not ask when there is only one option", async () => {
    const t = terminal();
    expect(await select(t.io, "Which branch?", [{ value: "main" }])).toBe("main");
  });
});

describe("wizard", () => {
  it("takes the branch from a pasted tree URL without asking", async () => {
    // The bug this fixes: `parseRepoSlug` drops everything past the repo
    // segment, so this URL used to silently scan the default branch.
    const t = terminal();
    const answers = runWizard(t.io, undefined);
    setTimeout(() => t.type("https://github.com/vercel/ms/tree/paul/use-vitest\n"), 40);
    expect(await answers).toEqual({
      target: "vercel/ms",
      ref: "paul/use-vitest",
    });
  }, 20000);

  it("never asks a local path for a branch", async () => {
    // `git log` reads HEAD and the file index reads the working tree, so any
    // branch other than what is checked out would score one branch's files
    // against another branch's history.
    const t = terminal();
    const answers = runWizard(t.io, undefined);
    setTimeout(() => t.type(".\n"), 40);
    const result = await answers;
    expect(result?.target).toBe(".");
    expect(result?.ref).toBeUndefined();
    expect(t.seen()).toContain("whatever is checked out");
  }, 20000);

  it("prints the equivalent command, so it teaches the flags", async () => {
    const t = terminal();
    const answers = runWizard(t.io, undefined);
    setTimeout(() => t.type(".\n"), 40);
    await answers;
    expect(t.seen()).toContain("repo-audit .");
  }, 20000);
});

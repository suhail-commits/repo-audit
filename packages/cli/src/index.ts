#!/usr/bin/env node
import { run } from "./main";

export { run, VERSION, type CliResult } from "./main";

/**
 * The binary.
 *
 * `run()` returns its output rather than printing, so everything above this
 * line is testable without spawning a process. This file is the only place
 * that touches `process`, which is what keeps that true.
 */
async function main(): Promise<void> {
  const result = await run(process.argv.slice(2));
  if (result.stdout) process.stdout.write(result.stdout);
  if (result.stderr) process.stderr.write(result.stderr);
  process.exitCode = result.exitCode;
}

main().catch((err: unknown) => {
  // Nothing below `run` should throw — it catches scan failures itself. If
  // something reaches here it is a bug in this tool, not a finding about the
  // repository, and the stack is the useful thing to print.
  console.error(err);
  process.exitCode = 1;
});

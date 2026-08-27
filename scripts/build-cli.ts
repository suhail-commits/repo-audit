import { execFileSync } from "node:child_process";
import { isBuiltin } from "node:module";
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import * as esbuild from "esbuild";

/**
 * Build the publishable CLI.
 *
 * One esbuild call, no plugin, into a generated staging directory. Publishing
 * from `packages/cli/dist` rather than from `packages/cli` keeps every
 * workspace package `private: true` forever, and means what ships is exactly
 * what this script wrote — not whatever a publish tool decided to rewrite.
 *
 * The assertions after the build are the reason this is a script rather than a
 * command line. A bundle that succeeds is not a bundle that is correct, and
 * three of the checks below have already been earned by real bugs in this
 * project.
 */

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const CLI = path.join(ROOT, "packages", "cli");
const OUT = path.join(CLI, "dist");
const BUNDLE = path.join(OUT, "cli.js");

const PACKAGE_NAME = "how-much-ai";
const BIN_NAME = "repo-audit";

/**
 * The lowest Node this can run on, and the reason is a silent wrong answer
 * rather than a crash.
 *
 * `term.ts` passes `{ stream }` to `styleText`. That option landed in v22.8.0
 * and was never backported to the 20.x line, where it is silently ignored — so
 * on Node 20 the colour decision stops following the stream and
 * `repo-audit . > report.txt` writes raw ANSI escapes into the file.
 * `oxc-parser` independently declares `^20.19.0 || >=22.12.0`, and this is the
 * half of that range the code actually supports.
 */
const NODE_FLOOR = ">=22.12.0";

const SHEBANG = "#!/usr/bin/env node";

function readJson(file: string): Record<string, unknown> {
  return JSON.parse(readFileSync(file, "utf8")) as Record<string, unknown>;
}

function fail(message: string): never {
  console.error(`\n  BUILD FAILED\n  ${message}\n`);
  process.exit(1);
}

/**
 * Dependencies that cannot be bundled, derived rather than typed twice.
 *
 * The same array becomes esbuild's `external` and the published manifest's
 * `dependencies`, so the two cannot drift and an engine dependency added later
 * cannot go missing from the package.
 *
 * `tar-stream` is here too, and an earlier version of this build got that
 * wrong. It is pure JS, and its `imports` map keys on `"fs"` rather than
 * `"#fs"` — which Node ignores entirely, so `bare-fs` never loads and only
 * costs install weight. That much was true. What it missed is that `tar-stream`
 * and its tree are **CommonJS**, and bundling CJS into an ESM output turns
 * every `require()` into an esbuild shim that throws on a builtin:
 *
 *     Error: Dynamic require of "events" is not supported
 *
 * The bundle built, passed every static assertion, and died the moment it ran.
 * Only the clean-room install caught it. Keeping it external costs about ten
 * installed-but-never-executed packages and buys a bundle that works.
 */
function externals(): Record<string, string> {
  const engine = readJson(path.join(ROOT, "packages", "engine", "package.json"));
  const deps = (engine["dependencies"] ?? {}) as Record<string, string>;

  const out: Record<string, string> = {};
  for (const [name, range] of Object.entries(deps)) {
    if (name.startsWith("@vibe/")) continue; // inlined by the bundler
    out[name] = range;
  }

  // A sanity check on the derivation itself: these four are the ones with
  // native binaries or runtime asset loading, and losing one silently would be
  // the exact class of bug this build exists to prevent.
  for (const required of [
    "oxc-parser",
    "oxc-resolver",
    "web-tree-sitter",
    "tree-sitter-wasms",
    "tar-stream",
  ]) {
    if (!(required in out)) {
      fail(`${required} is no longer a dependency of @vibe/engine — externals are wrong`);
    }
  }
  return out;
}

async function main(): Promise<void> {
  console.log("  typechecking…");
  try {
    // esbuild does not typecheck. Without this the build happily emits code
    // that `tsc` would reject, which is the one real cost of choosing it.
    // `shell: true` because pnpm is a `.cmd` wrapper on Windows and Node 22+
    // refuses to spawn those directly. No argument here contains a space.
    execFileSync("pnpm", ["typecheck"], { cwd: ROOT, stdio: "pipe", shell: true });
  } catch (err) {
    fail(`typecheck failed:\n${String(err).slice(0, 2000)}`);
  }

  rmSync(OUT, { recursive: true, force: true });
  mkdirSync(OUT, { recursive: true });

  const external = externals();
  console.log(`  bundling… (external: ${Object.keys(external).join(", ")})`);

  const result = await esbuild.build({
    entryPoints: [path.join(CLI, "src", "index.ts")],
    outfile: BUNDLE,
    bundle: true,
    /*
     * ESM, and this is load-bearing rather than a preference. CJS output would
     * rewrite `import.meta.url`, and `structural.ts` builds its grammar
     * resolver from `createRequire(import.meta.url)` — so a CJS bundle would
     * break every structural language at load, silently, which is precisely the
     * bug already recorded in *Bugs worth remembering*.
     */
    format: "esm",
    platform: "node",
    target: "node22",
    external: Object.keys(external),
    /*
     * No `banner`. `packages/cli/src/index.ts` already carries the shebang and
     * esbuild preserves it from the entry point, so adding one here produced
     * *two* — and `#!` is only legal on line 1, so line 2 was a syntax error
     * and the bundle would not start at all.
     */
    // Greppable by the verification, and readable stack traces in bug reports.
    // Size is noise beside 50 MB of grammars.
    minify: false,
    // A sourcemap embeds the absolute build path, which contains a username.
    sourcemap: false,
    metafile: true,
    logLevel: "silent",
  });

  assertBuild(result, external);
  writeManifest(external);
  writeReadme();

  const bytes = readFileSync(BUNDLE);
  console.log(
    `\n  ${PACKAGE_NAME} → ${path.relative(ROOT, BUNDLE)}  ${(bytes.length / 1024).toFixed(0)} kB`,
  );
  console.log(`  bin: ${BIN_NAME}    node: ${NODE_FLOOR}`);
  console.log(`  dependencies: ${Object.keys(external).length}\n`);
}

/** Everything that must be true of the bundle, checked rather than hoped. */
function assertBuild(
  result: esbuild.BuildResult<{ metafile: true }>,
  external: Record<string, string>,
): void {
  if (result.warnings.length > 0) {
    // esbuild has no warnings-as-errors, so it is done by hand.
    fail(
      `esbuild reported warnings:\n${result.warnings
        .map((w) => `    ${w.text}`)
        .join("\n")}`,
    );
  }

  const inputs = Object.keys(result.metafile.inputs);

  /*
   * Every input is either first-party source or one of the packages we
   * deliberately inline. This is what catches "someone added an npm dependency
   * to the CLI and nobody noticed" — it would appear here and fail the build
   * immediately, rather than shipping an undeclared dependency to strangers.
   *
   * The allowlist is `tar-stream` and its pure-JS tree. Listing them by name
   * rather than allowing `node_modules` wholesale is the point: a new arrival
   * fails the build and a person decides whether it belongs, instead of it
   * riding along unnoticed.
   */
  // Nothing third-party is inlined any more. A new arrival here fails the build
  // and a person decides whether it belongs, rather than riding along unseen.
  const BUNDLED = new Set<string>([]);

  const foreign: string[] = [];
  for (const raw of inputs) {
    const input = raw.replace(/\\/g, "/");
    if (/^packages\/[a-z]+\/src\//.test(input)) continue;
    // pnpm lays packages out as node_modules/.pnpm/<name>@<version>/node_modules/<name>/…
    const owner = /node_modules\/([^/]+)\/[^/]*$|node_modules\/([^/]+)\//.exec(
      input.slice(input.lastIndexOf("node_modules/")),
    );
    const name = owner?.[1] ?? owner?.[2] ?? "";
    if (BUNDLED.has(name)) continue;
    foreign.push(input);
  }

  if (foreign.length > 0) {
    fail(
      `bundle contains unexpected third-party inputs:\n${foreign
        .slice(0, 10)
        .map((f) => `    ${f}`)
        .join("\n")}\n  Add it to BUNDLED deliberately, or make it external.`,
    );
  }

  /*
   * Test-only code must never ship. `fixture-repo.ts` shells out to `git` and
   * writes to a temp directory; it is unreachable from the CLI's import graph
   * today, and this makes that structural rather than incidental.
   */
  const testing = inputs.filter((i) => i.replace(/\\/g, "/").includes("/src/testing/"));
  if (testing.length > 0) {
    fail(`bundle reaches test-only code:\n${testing.map((f) => `    ${f}`).join("\n")}`);
  }
  const tests = inputs.filter((i) => /\.test\.ts$/.test(i));
  if (tests.length > 0) {
    fail(`bundle reaches test files:\n${tests.map((f) => `    ${f}`).join("\n")}`);
  }

  /*
   * What the bundle imports at runtime must equal what the manifest declares,
   * in both directions. One direction catches a missing dependency; the other
   * catches a declared dependency nothing actually uses.
   */
  const output = Object.values(result.metafile.outputs)[0];
  const imported = (output?.imports ?? [])
    .filter((i) => i.external)
    .map((i) => i.path)
    // `isBuiltin` rather than a `node:` prefix check: older CJS packages in the
    // bundled tree import `fs` and `events` unprefixed, and those are builtins
    // too — not undeclared dependencies.
    .filter((p) => !isBuiltin(p));

  const declared = new Set(Object.keys(external));
  const undeclared = imported.filter((i) => !declared.has(i));
  if (undeclared.length > 0) {
    fail(`bundle imports packages the manifest does not declare: ${undeclared.join(", ")}`);
  }

  const bytes = readFileSync(BUNDLE, "utf8");

  /*
   * Byte-level, because a CRLF or a BOM here is invisible on Windows — where
   * this is built — and fatal on POSIX, where `env` would look for an
   * interpreter called `node\r`.
   */
  if (!bytes.startsWith(`${SHEBANG}\n`)) {
    fail(
      `bundle does not start with a clean shebang. First 32 bytes: ${JSON.stringify(bytes.slice(0, 32))}`,
    );
  }

  /*
   * Exactly one. A second `#!` on line 2 is a hard syntax error and the bundle
   * will not start at all. This check exists because the first version of this
   * build emitted two — the entry point carries one and the esbuild banner
   * added another — while the `startsWith` check above reported it clean.
   */
  const shebangs = bytes.split("\n").filter((l) => l.startsWith("#!")).length;
  if (shebangs !== 1) {
    fail(`bundle has ${shebangs} shebang lines; exactly one is legal`);
  }

  /*
   * The build path contains a username. It has no business in a published
   * artifact, and a stray absolute path is also a sign something was inlined
   * that should have stayed external.
   */
  if (bytes.includes(ROOT) || bytes.includes(ROOT.replace(/\\/g, "/"))) {
    fail("bundle contains the absolute build path");
  }

  /*
   * The grammar resolver depends on `import.meta.url` surviving. If a future
   * config change emits CJS, this is the check that notices before a user does.
   */
  if (!bytes.includes("import.meta.url")) {
    fail(
      "bundle has no `import.meta.url` — the grammar resolver cannot work. Is the format still ESM?",
    );
  }

  console.log(`  ${inputs.length} first-party inputs, no foreign code, shebang clean`);
}

function writeManifest(external: Record<string, string>): void {
  const cli = readJson(path.join(CLI, "package.json"));

  const manifest = {
    name: PACKAGE_NAME,
    version: cli["version"],
    description:
      "How much of a codebase was written by AI, with the evidence. Static analysis; no model is asked for an opinion.",
    type: "module",
    // No `main` and no `exports`: a bin-only package has no importable surface,
    // and a `main` pointing at the bin would make `import` run a scan.
    bin: { [BIN_NAME]: "./cli.js" },
    files: ["cli.js", "README.md"],
    engines: { node: NODE_FLOOR },
    dependencies: external,
    keywords: [
      "ai",
      "code-analysis",
      "static-analysis",
      "code-quality",
      "cli",
    ],
    repository: {
      type: "git",
      url: "git+https://github.com/suhail-commits/repo-audit.git",
    },
  };

  writeFileSync(
    path.join(OUT, "package.json"),
    JSON.stringify(manifest, null, 2) + "\n",
  );
}

/**
 * A CLI-specific README.
 *
 * The product README is written for someone looking at the repository and opens
 * on the hosted app, which is the wrong first paragraph for an npm page. And
 * `files` ships only what is listed, so without this the package would have no
 * readable page at all.
 */
function writeReadme(): void {
  const text = `# how-much-ai

How much of a codebase was written by AI, with the evidence for that claim.

No model is asked for an opinion. Every number comes from parsing the code and
reading the commit history, so the same repository always produces the same
report.

## Use it

\`\`\`bash
npx ${PACKAGE_NAME}                       # it asks which repository and branch
npx ${PACKAGE_NAME} .                     # scan the current checkout
npx ${PACKAGE_NAME} owner/repo            # ...or a public GitHub repository
npx ${PACKAGE_NAME} . --signals           # every signal, its weight and evidence
npx ${PACKAGE_NAME} --help                # everything else
\`\`\`

The command installs as \`${BIN_NAME}\`.

## What it reads

A local folder is read at full strength and **nothing leaves your machine** —
which is the point, since it means you can run this on private or work code.
Scanning through the GitHub API gives per-commit totals but no per-file changes,
so several history signals report themselves unavailable and confidence drops.
The report says which.

The one network call during a local scan is the dependency advisory lookup;
\`--offline\` turns it off.

**No code from the analysed repository is ever executed.**

## Requirements

Node ${NODE_FLOOR}.

Run \`${BIN_NAME} --selftest\` to check that the Python, Go and Rust grammars
loaded on your machine; it exits non-zero if any did not.

## Status

Verified on Windows. macOS and Linux are **not yet tested** — the parser ships a
different native binary per platform, and this package has no CI yet. If it
fails to run, \`${BIN_NAME} --selftest\` output is the useful thing to report.
`;
  writeFileSync(path.join(OUT, "README.md"), text);
}

await main();

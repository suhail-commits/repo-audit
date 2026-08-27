import { execFileSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

/**
 * Pack the CLI, install it somewhere it has no help, and prove it still works.
 *
 * **This is the only check that can catch the failure this package is most
 * likely to have.** A missing tree-sitter grammar is silent: `getParser`
 * swallows the error, the language drops to the history tier, and the report
 * looks completely healthy on a JavaScript repository. That is not a
 * hypothetical — it shipped once already, in the web build, where Turbopack
 * compiled the grammar resolver into an unconditional throw and every deployed
 * scan of a Python, Go or Rust repository was wrong. No test failed.
 *
 * Two rules follow from that, and they are the whole design:
 *
 * 1. **Assert on something a broken package cannot fake.** `duplicate-functions`
 *    over a Python/Go/Rust fixture is unreachable without a grammar genuinely
 *    parsing — and because the clone hash is built from real grammar node-type
 *    names, a wrong-ABI grammar producing garbage names fails too. Compare
 *    `analysisTier`, which is computed from file extensions and reads
 *    "structural" on a completely dead engine.
 * 2. **Break it deliberately, every run.** A verification never seen to go red
 *    is not a verification. The sabotage at the end is not optional and not
 *    behind a flag, because a control you have to remember to run is one that
 *    rots.
 */

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const DIST = path.join(ROOT, "packages", "cli", "dist");

const EXPECTED_FILES = ["README.md", "cli.js", "package.json"];

let failures = 0;

function check(ok: boolean, label: string, detail?: string): void {
  if (ok) {
    console.log(`  ok    ${label}`);
    return;
  }
  failures++;
  console.log(`  FAIL  ${label}${detail ? `\n        ${detail}` : ""}`);
}

/**
 * Run a command, quoting arguments that a shell would otherwise split.
 *
 * `npm` and `pnpm` are `.cmd` wrappers on Windows, and Node 22+ refuses to
 * spawn those without a shell — so `shell: true` is not optional here. But a
 * shell concatenates rather than escapes, so any argument containing a space
 * has to be quoted by hand. That is not hypothetical: this repository lives at
 * `C:\personal project\vibe`, and the temp paths this script builds are passed
 * as arguments.
 */
function run(cmd: string, args: string[], cwd: string): string {
  const quoted = args.map((a) => (/[\s"]/.test(a) ? JSON.stringify(a) : a));
  return execFileSync(cmd, quoted, {
    cwd,
    stdio: "pipe",
    encoding: "utf8",
    shell: true,
    timeout: 300_000,
    env: childEnv(),
  });
}

/**
 * The environment, with `NODE_PATH` removed.
 *
 * **This is the single most important line in the file, and it was missing.**
 * pnpm sets `NODE_PATH` for every script it runs, pointing at the workspace's
 * virtual store — which contains every package in the monorepo, including
 * `tree-sitter-wasms`. A child process inherits it, so the freshly installed
 * CLI resolved the *repository's* grammars and reported a perfectly healthy
 * install from a room that provably contained no `.wasm` file at all.
 *
 * The clean room defends against a `node_modules` in an ancestor directory.
 * This defends against the same thing arriving as an environment variable,
 * which is harder to see and was what actually happened: the sabotage looked
 * broken for four separate reasons before this turned out to be the cause.
 */
function childEnv(): NodeJS.ProcessEnv {
  const env = { ...process.env };
  delete env["NODE_PATH"];
  return env;
}

/**
 * A directory with no `node_modules` anywhere above it.
 *
 * Both halves matter. A stray `node_modules` in an ancestor lets npm resolve a
 * dependency the tarball forgot to declare, turning a red gate green. And
 * `grammarPath` falls back to walking up from `process.cwd()` looking for
 * `node_modules/tree-sitter-wasms` — so running this anywhere under the source
 * repo would find the *workspace's* grammars and pass even if the package
 * shipped none. That fallback is ours, added to survive bundlers, and here it
 * is a hazard.
 */
function cleanRoom(): string {
  const dir = mkdtempSync(path.join(tmpdir(), "how-much-ai-verify-"));

  let cursor = dir;
  for (;;) {
    if (existsSync(path.join(cursor, "node_modules"))) {
      rmSync(dir, { recursive: true, force: true });
      throw new Error(
        `refusing to verify: ${path.join(cursor, "node_modules")} exists and would mask a missing dependency`,
      );
    }
    const parent = path.dirname(cursor);
    if (parent === cursor) break;
    cursor = parent;
  }
  return dir;
}

/**
 * A repository designed so that only a working install can score it.
 *
 * The structural half contains **no JavaScript or TypeScript at all**: three
 * type-2 clones per language, differing only in names and literals, which the
 * clone hasher erases. The JS/TS half lives in its own directories and exists
 * to prove the two native oxc bindings, which fail loudly rather than silently
 * and so need only a weak assertion.
 */
function writeFixture(dir: string): void {
  const write = (rel: string, body: string) => {
    const full = path.join(dir, rel);
    mkdirSync(path.dirname(full), { recursive: true });
    writeFileSync(full, body);
  };

  // ---- Python -------------------------------------------------------------
  const py = (name: string, sep: string) => `def ${name}(value):
    parsed = parse_date(value)
    year = parsed.year
    month = parsed.month
    day = parsed.day
    joined = str(year) + "${sep}" + str(month) + "${sep}" + str(day)
    return joined
`;
  write("svc/format_a.py", py("format_date", "-"));
  write("svc/format_b.py", py("pretty_date", "/"));
  write("svc/format_c.py", py("render_date", "."));

  // ---- Go -----------------------------------------------------------------
  const go = (name: string, sep: string) => `package svc

func ${name}(value string) string {
	parsed := parseDate(value)
	year := parsed.Year
	month := parsed.Month
	day := parsed.Day
	joined := year + "${sep}" + month + "${sep}" + day
	return joined
}
`;
  write("svc/format_a.go", go("FormatDate", "-"));
  write("svc/format_b.go", go("PrettyDate", "/"));
  write("svc/format_c.go", go("RenderDate", "."));

  // ---- Rust ---------------------------------------------------------------
  const rs = (name: string, sep: string) => `pub fn ${name}(value: &str) -> String {
    let parsed = parse_date(value);
    let year = parsed.year;
    let month = parsed.month;
    let day = parsed.day;
    let joined = format!("{}${sep}{}${sep}{}", year, month, day);
    joined
}
`;
  write("svc/format_a.rs", rs("format_date", "-"));
  write("svc/format_b.rs", rs("pretty_date", "/"));
  write("svc/format_c.rs", rs("render_date", "."));

  // ---- JS/TS island: routes prove oxc parsed --------------------------------
  write(
    "app/api/thing/route.ts",
    `export async function GET() {
  return new Response("ok");
}

export async function POST() {
  return new Response("made");
}
`,
  );

  // ---- JS/TS island: a cross-directory import proves oxc-resolver resolved ---
  write("src/a.ts", `import { helper } from "../lib/x";\n\nexport const a = () => helper();\n`);
  write("src/b.ts", `export const b = 2;\n`);
  write("lib/x.ts", `export function helper(): number {\n  return 1;\n}\n`);
  write("lib/y.ts", `export const y = 3;\n`);

  write("package.json", JSON.stringify({ name: "fixture", version: "1.0.0" }, null, 2));
}

/** Block the thread. Used only to let a filesystem change settle. */
function sleepSync(ms: number): void {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

/**
 * Poll `--selftest` until it reports the degraded install, or give up.
 *
 * Returns false if the sabotage never took, which the caller reports as a
 * failure — a control that quietly gives up is worse than no control.
 */
function waitUntilBroken(room: string, attempts = 12): boolean {
  for (let i = 0; i < attempts; i++) {
    try {
      run(binPath(room), ["--selftest"], room);
    } catch {
      return true; // non-zero exit: the grammars are gone, as intended
    }
    sleepSync(250);
  }
  return false;
}

/** Every directory of the given name anywhere under `root`. */
function findAll(root: string, name: string): string[] {
  const out: string[] = [];
  const walk = (dir: string, depth: number): void => {
    if (depth > 6) return;
    let entries;
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      const full = path.join(dir, entry.name);
      if (entry.name === name) {
        out.push(full);
        continue; // no need to descend into the thing we are looking for
      }
      walk(full, depth + 1);
    }
  };
  walk(root, 0);
  return out;
}

interface ScanJson {
  repo: { analysisTier: string };
  metrics: { id: string; value: number }[];
  findings: { ruleId: string; locations: { file: string }[] }[];
  warnings: string[];
  moduleGraph?: { nodes: unknown[]; edges: unknown[] };
}

/** The installed binary, through npm's shim rather than around it. */
function binPath(room: string): string {
  return path.join(
    room,
    "node_modules",
    ".bin",
    process.platform === "win32" ? "repo-audit.cmd" : "repo-audit",
  );
}

function scan(room: string, fixture: string): ScanJson {
  const bin = binPath(room);
  // Through the bin shim, not `node .../cli.js` — that is what exercises the
  // `bin` field and the shim npm generates for it.
  const out = run(bin, [fixture, "--json", "--offline"], room);
  return JSON.parse(out) as ScanJson;
}

function metric(result: ScanJson, id: string): number {
  return result.metrics.find((m) => m.id === id)?.value ?? 0;
}

async function main(): Promise<void> {
  console.log("\n  building…");
  run("pnpm", ["build"], ROOT);

  console.log("  packing…");
  const listed = JSON.parse(
    run("npm", ["pack", "--dry-run", "--json"], DIST),
  ) as { files: { path: string }[] }[];
  const shipped = (listed[0]?.files ?? []).map((f) => f.path).sort();
  check(
    JSON.stringify(shipped) === JSON.stringify(EXPECTED_FILES),
    "the tarball contains exactly the expected files",
    `got ${JSON.stringify(shipped)}`,
  );

  const packed = run("npm", ["pack", "--silent"], DIST).trim().split("\n").pop()!;
  const tarball = path.join(DIST, packed);

  const room = cleanRoom();
  console.log(`  clean room: ${room}`);

  try {
    /*
     * npm, not pnpm, deliberately. npm's optional-dependency bug is named
     * verbatim in oxc's own error message, so npm is the risky installer and
     * therefore the one worth testing. pnpm's symlinked store could also
     * resolve back into the workspace.
     */
    run("npm", ["init", "-y"], room);
    console.log("  installing the tarball…");
    run("npm", ["install", "--no-audit", "--no-fund", tarball], room);

    const fixture = path.join(room, "fixture");
    writeFixture(fixture);

    console.log("\n  --- the installed package, on a real repository ---");
    const result = scan(room, fixture);

    const duplicates = metric(result, "duplicate-functions");
    check(
      duplicates >= 3,
      `structural grammars ran (duplicate-functions = ${duplicates})`,
      "zero means no grammar loaded — the .wasm assets did not survive packaging",
    );

    const cloneFiles = result.findings
      .filter((f) => f.ruleId === "duplicate-function")
      .flatMap((f) => f.locations.map((l) => l.file));
    for (const ext of [".py", ".go", ".rs"]) {
      check(
        cloneFiles.some((f) => f.endsWith(ext)),
        `${ext} clones detected — that grammar works individually`,
      );
    }

    check(
      !result.warnings.some((w) => /grammar unavailable/.test(w)),
      "no grammar reported itself unavailable",
      result.warnings.filter((w) => /grammar/.test(w)).join("; "),
    );

    const routes = metric(result, "routes");
    check(routes > 0, `oxc parsed JavaScript (routes = ${routes})`);
    check(
      result.moduleGraph !== undefined && (result.moduleGraph?.edges.length ?? 0) > 0,
      "oxc-resolver resolved a cross-directory import (module graph has edges)",
    );

    const selftest = run(binPath(room), ["--selftest"], room);
    check(
      !selftest.includes("FAILED"),
      "--selftest reports every grammar loaded",
      selftest.split("\n").filter((l) => l.includes("FAILED")).join("\n        "),
    );

    // ---- The control -------------------------------------------------------
    console.log("\n  --- sabotage: the same checks must now fail ---");

    /*
     * The sabotage gets its OWN room, installed fresh and broken before a
     * single scan touches it.
     *
     * The first version broke the healthy room in place, and the control kept
     * reporting the grammars as working even after the directory was verifiably
     * renamed away — while running the very same binary by hand, once the
     * script had exited, failed correctly. The likeliest explanation is Windows
     * still serving `.wasm` files that the successful scan moments earlier had
     * memory-mapped.
     *
     * Rather than race that, install a second copy and remove the grammars
     * before anything reads them. That is also the more honest control: it
     * tests *a package that shipped without grammars*, which is the failure
     * being guarded against, rather than *a package whose grammars were pulled
     * out from under a running session*, which is not.
     */
    const broken = cleanRoom();
    try {
      run("npm", ["init", "-y"], broken);
      run("npm", ["install", "--no-audit", "--no-fund", tarball], broken);

      const copies = findAll(path.join(broken, "node_modules"), "tree-sitter-wasms");
      check(copies.length > 0, "found the grammars to remove", "nothing to sabotage");
      for (const copy of copies) rmSync(copy, { recursive: true, force: true });
      check(
        findAll(path.join(broken, "node_modules"), "tree-sitter-wasms").length === 0,
        `grammars removed before first use (${copies.length} cop${copies.length === 1 ? "y" : "ies"})`,
      );

      const brokenFixture = path.join(broken, "fixture");
      writeFixture(brokenFixture);

      /*
       * Wait for the removal to be visible to a *child process*.
       *
       * Removing the directory and immediately scanning reported the grammars
       * still loading — reproducibly, in a room that had never scanned, whose
       * `node_modules` provably contained no `.wasm` at all, and where running
       * the same binary by hand a moment later failed correctly. Windows
       * evidently serves a stale directory entry to a freshly spawned process.
       *
       * So the control waits for its own sabotage to take effect rather than
       * assuming it is instant. If it never takes effect, that is a failure in
       * its own right and is reported as one — never silently skipped.
       */
      const brokenNow = waitUntilBroken(broken);
      check(
        brokenNow,
        "--selftest exits non-zero on a degraded install",
        "the sabotage never became visible to a child process",
      );

      let sabotaged: ScanJson | null = null;
      try {
        sabotaged = scan(broken, brokenFixture);
      } catch {
        sabotaged = null;
      }
      const afterDuplicates = sabotaged ? metric(sabotaged, "duplicate-functions") : -1;
      check(
        afterDuplicates === 0,
        `without the grammars the check goes red (duplicate-functions = ${afterDuplicates})`,
        "it passed without them, so it is measuring something else",
      );
      check(
        (sabotaged?.warnings ?? []).some((w) => /grammar unavailable/.test(w)),
        "and the scan says so in its warnings",
      );

      /*
       * oxc fails loudly by design: a missing native binding throws at module
       * evaluation, so the process dies rather than degrading quietly. Every
       * weak assertion elsewhere in this script depends on that being true, so
       * it is checked rather than assumed.
       */
      rmSync(path.join(broken, "node_modules", "oxc-parser"), {
        recursive: true,
        force: true,
      });
      let oxcFailed = false;
      try {
        scan(broken, brokenFixture);
      } catch {
        oxcFailed = true;
      }
      check(oxcFailed, "removing oxc-parser fails loudly, as the risk model assumes");
    } finally {
      if (failures === 0) {
        rmSync(broken, { recursive: true, force: true });
      } else {
        console.log(`  sabotage room kept: ${broken}`);
      }
    }
  } finally {
    // Kept on failure. The room *is* the evidence, and deleting it turns a
    // reproducible problem into a description of one.
    if (failures === 0) {
      rmSync(room, { recursive: true, force: true });
    } else {
      console.log(`\n  clean room kept for inspection: ${room}`);
    }
    rmSync(tarball, { force: true });
  }

  console.log(
    failures === 0
      ? "\n  the packed tarball installs and works in a clean room\n"
      : `\n  ${failures} check(s) failed\n`,
  );
  process.exitCode = failures === 0 ? 0 : 1;
}

await main();

# Repo Audit

Static analysis that tells you how much of a codebase was AI-generated, with evidence, and what
that left behind. Paste a public GitHub repo, get a report.

**This is a portfolio project.** That framing drives most trade-offs here:

- **The engine is the story, not the app.** Depth in the analysis beats breadth in features.
  Clone detection, git forensics, and the confidence model are what make it interesting.
- **The failure mode is "someone technical pastes their own repo and gets an obviously wrong
  answer."** False positives are the top risk, ahead of missing findings. Two were already found
  on the first real repo tested (`sindresorhus/p-limit`) — see *Bugs worth remembering*.
- **A finished narrow thing beats an ambitious half-built one.** Prefer cutting scope to shipping
  something that only half works.

---

## Git identity — non-negotiable

Every commit in this repo is authored by Suhail. Configure once per clone, then never deviate:

```bash
git config user.name  "suhail-commits"
git config user.email "suhaildope@gmail.com"
```

- **Never add AI attribution.** No `Co-Authored-By:` trailer, no "Generated with", no tool name,
  no 🤖. The commit message describes the change and nothing else.
- **Never commit as `suhail-commitz`.** That is a separate GitHub account (used for EdgeUp work).
  This repo belongs to `suhail-commits`. Both are authenticated in `gh`, so confirm with
  `gh auth status` before any remote operation and switch with
  `gh auth switch --user suhail-commits`.
- Set identity **locally** (`git config`, not `--global`) so other projects are unaffected.

## Git commits — mandatory format

**Every commit uses the template for its type, with all sections filled in. Every commit, every
time, without being asked.** Subject line ≤72 chars, imperative mood, no trailing period.

**`fix:` — bug fix**
```
fix(<scope>): <what was broken>

## Problem
<What broke, observably. 1-3 sentences.>

## Root cause
<Why it broke. Name the file/function.>

## Solution
<What this commit changes.>
```

**`feat:` — new capability**
```
feat(<scope>): <what it adds>

## What it does
<From the user's perspective. 1-3 sentences.>

## Why we built it
<The motivation.>
```

**`refactor:` — restructure, no behaviour change**
```
refactor(<scope>): <what was restructured>

## What changed
## Why
```

**`perf:` — performance**
```
perf(<scope>): <what got faster>

## What was slow
## What changed
## Improvement
<Measured, e.g. 206 imports resolved 0 → 157.>
```

**`test:` / `chore:` / `docs:`** — subject line alone is fine, body optional.

**Scopes**: `engine`, `rules`, `shared`, `web`, `ingest`, `index`, `analyzers`, `score`,
`scripts`, `docs`, `ci`, `deps`.

**Signal fixes cite the repo that exposed them.** This project's bugs are found by scanning real
codebases, and which repo broke it is the most useful fact in the message — write
"seen on `sindresorhus/ky`", not "fixed a resolver bug".

## Push and branches

- **Never push without being asked.** Committing is free and reversible; pushing is not.
- **Never commit directly to `main` for anything non-trivial.** Branch as
  `feat/<short-name>` / `fix/<short-name>`.
- **Never force-push** a shared branch, and never rewrite pushed history, without an explicit
  instruction.
- **Never commit without being asked.** Finish the work, pass the gate, then *report and stop* —
  say what changed and what the gate returned, and wait. A commit made before I have looked at the
  code is a commit spent on something I may not want, and undoing it costs more than waiting did.
  This is the same rule as pushing, one step earlier.
- When I do say commit, commit at each logical checkpoint — a working, tested unit of change — not
  once per session and not once per file.

## How I work

1. **Verify, don't assert.** Check the actual version, run the actual command, read the actual
   file. Every confident claim in this project that went unchecked turned out wrong: `pkill` not
   killing Windows processes, an oxc version emitting different AST node names, `pnpm typecheck`
   silently skipping the entire web app.
2. **Never commit red.** `pnpm vitest run` and `pnpm typecheck` both pass before every commit. No
   exceptions, no "I'll fix it next commit".
3. **Real repos beat fixtures.** Synthetic tests passed 52 green while two real false positives sat
   undetected. After touching any signal, run `pnpm sweep` — a score above ~30 on a known
   hand-written repo is a bug, not a result.
4. **Every bug fixed on a real repo gets a regression test and a line in *Bugs worth remembering*.**
   That list is why the same mistake is not made twice; three separate assertion-style bugs shipped
   before the pattern was recognised.
5. **A false positive costs more than a missed finding.** The failure mode is a reviewer pasting
   their own repo and getting an obviously wrong answer. When uncertain, report less and say so.
6. **Report honestly.** If tests fail, show the output. If something was skipped, say so. If a
   claim was wrong, correct it plainly and move on. Never describe work as done that is not done.
7. **Dependencies are a cost.** Six runtime dependencies today, in a tool that flags dependency
   bloat. Adding one needs a reason beyond convenience.
8. **Ask before destroying.** Deletions, overwrites and history rewrites get confirmed first —
   especially anything not yet pushed, which has no remote copy to recover from.

## Execution flow

### The loop

Every task runs this sequence. Steps are not skipped because something "looks small" — the
expensive mistakes in this repo all came from skipping step 2.

1. **Understand.** Restate the ask in one line. Find the code that already does something similar
   and reuse it. `scanRepository()`, `TemplateNarrator`, `createFixtureRepo()` and the extraction
   guards all exist; rebuilding them is a bug, not a contribution.
2. **Verify the assumptions the change rests on.** Read the file, check the installed version, run
   the command. Do not build on top of a belief.
3. **Change in small steps.** One coherent thing at a time, with the test written alongside — not
   a large edit followed by a hunt for what broke.
4. **Pass the gate** (below). Non-negotiable.
5. **Commit** at that checkpoint, using the template for the type.
6. **Report** what happened, including what did not work and what was left out.

### The gate — before every commit

```bash
pnpm vitest run      # all green
pnpm typecheck       # covers packages AND apps/web
```

Additionally, **if a signal, index, or the scorer changed**:

```bash
pnpm scan .          # authorship ~17, health ~3, security ~29; see below for which signals fire
pnpm sweep           # median ~5, max under 30, nothing claiming `certain`
```

`pnpm scan .` is the fastest real check that exists, but it is **no longer a "everything must read
0.00" check** — four signals legitimately fire on this repository and knowing which is the point:

- `agent-tooling` **1.00** — `CLAUDE.md` is right there. Correct, and the reason the signal exists.
- `commit-size` **~0.74** — the median commit here really is around 465 lines. A true measurement.
- `unauthenticated-routes` **1.00** — `POST /api/scans` really is open to anyone, by design. It is
  the only state-changing route in the repo, so the ratio is 1/1. A true measurement of a
  deliberate choice.
- `missing-license` **1.00** — there is no `LICENSE` file in this repository and `package.json`
  declares none. Also a true measurement. **Security lands around 29 here and that is the
  baseline**, not a bug; it was 21 before the licence checks landed.

`build-velocity` reports **unavailable** here (one active day is a point, not a span), so does
`license-mismatch`, which needs both a licence file and a declaration to compare, and so does
`refactor-ratio` — twenty commits over two days is too short a history to have refactored anything.
**That last one is load-bearing:** this repository's median commit deletes only 8.5% of what it
changes, against 33–50% across the whole hand-written corpus, so without the maturity guard it
would fire at nearly full value on our own code.

**Anything beyond those four firing is a false positive to investigate.**

`pnpm sweep --emit-baseline` additionally prints `CORPUS_BASELINE` as pasteable source. **Run it
whenever a signal is added or changed** — a new signal redistributes weight across every score, so
the distribution the report compares against goes stale even though nothing about the corpus moved.

### Deciding versus asking

- **A question is not a work order.** "What happens if…", "how would we…", "I have a doubt about…"
  means *explain it and lay out the options*, then stop. Do not open an editor. This holds even
  when the answer is obvious and the fix is three lines — **especially** then, because an obvious
  fix is the easiest thing to apply to the wrong problem. Answer, propose, wait.
- **Discussion first for anything that changes behaviour or shape**: a new guard, a schema change,
  a dependency, a rename, an abandoned approach. Describe what would change and why, get a yes,
  then build.
- **Decide alone** when the choice is reversible, internal, and has a conventional default. State
  the choice in the report and move on.
- **Ask first** when different readings produce materially different work, when the action is
  outward-facing (pushing, deploying, creating a repo), or when it destroys something. There is no
  undo for a delete beyond the last commit, and unpushed commits have no remote copy.
- **When a plan turns out wrong mid-way**, stop and say so rather than forcing the original
  approach through. Report what was learned, propose the correction, and do not quietly widen scope
  to accommodate it.

### Playbook — adding or changing an authorship signal

1. Implement in `packages/engine/src/analyzers/authorship/`, returning a `Signal`. If inputs can be
   missing, return `available: false` with an `unavailableReason` — **never** a value of 0.
2. Register it with a weight in `analyzers/authorship/index.ts`.
3. If it emits a `Finding`, write its template in `packages/rules/src/templates.ts`.
   `narrator.test.ts` fails if an engine rule falls through to the generic fallback.
4. Unit-test both directions against `createFixtureRepo()`: the case that fires, and a clean case
   that must stay silent. The silent case is the one that matters.
5. Run `pnpm scan .`, then `pnpm sweep`. A signal that fires on hand-written code is not finished.
6. If it can be unavailable, prove the degradation lowers *confidence* and leaves the score alone.

### Playbook — a false positive found on a real repo

1. **Reproduce it directly first**, calling the analyzer against the cloned repo, before changing a
   line. Twice in this project a "fix" was judged against a stale worker process still running the
   old code.
2. Fix the cause, not the symptom. Three assertion-style bugs shipped separately because each was
   patched as a one-off instead of at the import level.
3. Add a regression test that **names the repo** that exposed it.
4. Re-run `pnpm sweep` and compare the before/after numbers explicitly.
5. Add an entry to *Bugs worth remembering* with the repo and the figure.

### Playbook — adding a dependency

1. Justify it beyond convenience. Six runtime dependencies today, in a tool that flags dependency bloat.
2. Confirm it installs on Windows with no build toolchain — prebuilt binaries or WASM only.
3. Native bindings or runtime file access → add to `serverExternalPackages` in
   `apps/web/next.config.ts`, or it breaks only at runtime.
4. Confirm it survives the deploy target: no `git` binary, no writable filesystem outside `/tmp`,
   a hard function duration cap.

### Playbook — upgrading `oxc-parser`

Pre-1.0, ships a minor roughly weekly, and has already renamed AST nodes once — silently returning
zero routes rather than erroring.

1. Upgrade deliberately, never as part of a blanket update.
2. Run `pnpm vitest run parser-contract` **first**; it pins the node names and module-record shape.
3. Then the full suite and `pnpm sweep`.

---

## Invariants

These are load-bearing. Breaking one is a correctness bug, not a style preference.

1. **Never execute analyzed code.** No install, no build, no test run, no hooks. Read and parse
   only. We process untrusted repositories.
2. **A missing signal lowers *confidence*, never the score.** Unavailable signals are excluded and
   their weight redistributed across the rest. Treating a missing signal as zero would make a repo
   with no git history score *cleaner* than the same repo with it — exactly backwards. See
   `packages/engine/src/score/index.ts`.
3. **`certain` confidence is reserved for ground truth.** A `Co-Authored-By: Claude` trailer is
   ground truth. A heuristic never claims `certain`.
4. **Calibration withholds ground-truth signals.** The separation test runs with
   `structuralOnly: true` so it proves the *structural* signals work rather than proving we can
   grep for a commit trailer. Never "fix" a failing calibration by re-enabling them.
5. **Report what you could not determine.** Unresolvable routes are counted and surfaced, never
   assumed safe. Unsupported languages are named, not silently skipped.
6. **The LLM may filter, rank, and explain — never originate a finding.** Every claim must trace
   back to something measured. (BYOK is not built yet.)
7. **The user's API key never reaches the server.** BYOK calls go from the browser to the provider.

---

## Layout

```
packages/shared   types + score bands       (no dependencies)
packages/engine   all analysis              (shared)
packages/rules    report prose, personas    (shared; engine as devDep for tests)
apps/web          Next.js UI                (all three)
```

Dependency direction is one-way: `shared ← engine ← rules ← web`. `engine` must never import
`rules`.

### Engine pipeline

`ingest → index → analyze → score → render`

The **index layer is the central design decision**: every file is parsed exactly once and all
analyzers read from shared indexes. Analyzers are pure functions of an `AnalysisContext`
(`packages/engine/src/analyzers/context.ts`) and never touch the filesystem.

| Index | Purpose |
|---|---|
| `FileIndex` | every relevant file, read once — content, sloc, hash, test/generated flags |
| `AstIndex` | oxc parse trees for **JS/TS only** |
| `PythonIndex` | tree-sitter trees for Python. Async (WASM init) |
| `GitIndex` | commits, authors, churn. **`Commit[]` is the seam** — analyzers read only that array, so `GitIndex.build(path)` (local) and `GitIndex.fromCommits()` (GitHub API) are interchangeable |
| `ImportGraph` | module edges via `oxc-resolver`, including re-exports. **JS/TS only** |
| `RouteTable` | HTTP routes: Next App Router, Pages API, Express/Hono/Fastify |
| `languages` | per-language line shares and the analysis tier |

### Analysis tiers

| Tier | Languages | Signals |
|---|---|---|
| full | JS/TS (oxc) | all 16 |
| structural | Python (tree-sitter) | clones, obvious comments, test assertions, swallowed errors, + history |
| structural | Go, Rust (tree-sitter) | clones, obvious comments, + history |
| history | everything else | trailers, commit shape, velocity, platform |

**The structural tier is not one thing.** Python's test and error conventions are wired in; Go's
and Rust's are not, because `assert_eq!` and `if err != nil` look nothing like the constructs those
signals match. `tierWarnings()` in `scan.ts` says which of the two a language got — claiming
"analyzed structurally" for all of them would promise checks that never ran.

**A grammar that loads is not a language that is analysed.** `tree-sitter-wasms` ships thirty-odd
grammars and every obvious one loads fine under the pinned ABI. What makes a language supported is
its node names being wired into `GRAMMAR_SHAPES` in `clones.ts` and a real repository in it being
swept — `collectStructuralFunctionShapes` returns nothing for a language with no table, because a
shape built from unrecognised node types hashes consistently and would report confident,
meaningless duplication.

**Any signal that depends on JS/TS-only machinery must check for it and report
unavailable.** `orphan-files` needs `ImportGraph`, which has no Python edges — judging Python
anyway reported every file in every Python repo as unreachable.

`scanRepository()` in `packages/engine/src/scan.ts` is the single entry point and returns a
complete `ScanResult`.

---

## Commands

```bash
pnpm vitest run                          # all tests
pnpm typecheck                           # tsc -b
pnpm sweep                               # false-positive sweep over known hand-written repos
pnpm scan <path>                         # raw signal breakdown (dev tool)
pnpm scan <path> --structural-only       # ground-truth signals disabled, as calibration runs
pnpm report <path> --persona=founder     # the narrated report
pnpm web                                 # Next.js dev server
```

**`pnpm scan .` on this repo is the fastest sanity check.** Authorship lands around 17, health
around 3 and security around 29, with exactly four signals above zero — `agent-tooling`,
`commit-size`, `unauthenticated-routes` and `missing-license` — and `build-velocity`,
`license-mismatch` and `refactor-ratio` correctly reporting unavailable. See *The gate* for why each
is a true measurement. A **fifth** signal firing on our own hand-written code is a false positive to
investigate, not a result; that check has already caught two real bugs.

---

## Testing

- Fixtures come from `createFixtureRepo()` (`packages/engine/src/testing/fixture-repo.ts`), which
  builds throwaway git repos on disk with real commit history. Exported as `@vibe/engine/testing`.
- `packages/rules/src/narrator.test.ts` fails if any engine rule has no hand-written template and
  falls through to the generic fallback. Every new rule needs a template in
  `packages/rules/src/templates.ts`.
- `packages/engine/src/index/parser-contract.test.ts` pins the oxc AST node names and module-record
  shape. It exists because oxc renamed nodes once and silently broke route extraction.

**Synthetic fixtures are not enough.** They passed 52 tests while missing two real false positives.
Test against real repositories before trusting a signal.

`pnpm sweep` (`scripts/false-positive-sweep.ts`) clones ~18 well-known, unambiguously hand-written
repos across JS/TS and Python and scores them. **Anything above ~30 is a bug to investigate, not a
result.** This is the highest-value test in the project, because the failure mode is a reviewer
pasting their own repo and getting an obviously wrong answer. Its first run found five distinct
false positives, all listed below. Clones are full, not shallow — a shallow clone compresses the
active-day span and makes `build-velocity` fire spuriously.

Current baseline: **median 5, max 25 across 20 repos, none above 30, none claiming `certain`.**
The median moved 6 → 5 when `refactor-ratio` landed: a sixteenth signal redistributes weight across
every score, so absolute numbers shift even where nothing about an existing signal changed.

The sweep also prints **every security finding in full rather than a count**, because the corpus is
a far better oracle for security than for anything else. For authorship it can only show a signal
stays quiet on hand-written code; for secrets it is close to a true-negative proof, since a live
credential in one of the most-read repositories in open source would have been revoked years ago.
**Any security finding on the sweep is a bug in us until proven otherwise** — the current baseline
is *clean across all 20*, and the one finding it ever produced was our own false positive.

The max moved 19 → 28 when `agent-tooling` landed, and that is a correct result rather than a
regression: `colinhacks/zod` and `remeda/remeda` both carry committed agent configuration, and
`tkem/cachetools` scores 24 on real duplication. **When a sweep number rises, find the repo and
read its evidence before touching the signal.** Restoring an old number by weakening detection is
the one move that is never allowed here.

---

## Environment gotchas

Each of these cost real debugging time.

- **Turbopack has no `extensionAlias`.** The TypeScript `.js`-means-`.ts` convention does not
  resolve, so internal imports are **extensionless**. Keep it that way.
- **`import.meta.dirname` is `undefined` once bundled.** Reading a sibling asset at runtime
  silently becomes `path.join(undefined, …)`. Inline such content instead.
- **Packages with native binaries or runtime file access must be in `serverExternalPackages`**
  (`apps/web/next.config.ts`): `oxc-parser`, `oxc-resolver`, `web-tree-sitter`, `tree-sitter-wasms`.
  Bundling them breaks them in ways that surface only at runtime.
- **`oxc-parser` is pre-1.0 and ships a minor roughly weekly.** `^0.x` resolves to patches only, so
  upgrades are manual — and must be verified against the parser contract test.
- **`web-tree-sitter` is pinned to `0.24.7`** to match the prebuilt `tree-sitter-wasms` grammars;
  0.26 rejects them with an ABI mismatch.
- **The Python grammar path is assembled at runtime** (`["tree-sitter-wasms","out",…].join("/")`).
  Given a literal, Turbopack treats `require.resolve("….wasm")` as an import and fails the build
  trying to bundle a binary. It reaches the deployment via `outputFileTracingIncludes`.
- **Node's `child_process` rejects arguments containing NUL bytes.** `git log --pretty=format:`
  separators must use git's own `%x00` escapes rather than literal control characters.
- **`vitest.config.ts` covered only `packages/*`.** A test written beside web code was collected by
  nothing and passed by default — the same shape as `pnpm typecheck` silently skipping the whole web
  app. The include list is now `packages/*` **and** `apps/*`.
- **Next 16 refuses a second `next dev` for the same directory**, so there is no "start another one
  on a spare port" while yours is running. Separately, editing a workspace package mid-request makes
  HMR re-evaluate server modules between a `POST /api/scans` and the `GET /scan/<id>` that follows,
  and the report 404s. It is not the in-memory store being broken — let the edits settle and retry.
- **On Windows, `pkill -f` does not kill node processes.** Use `taskkill` via PowerShell, and
  verify the process is gone — stale processes running old code produce confusing results.
- **GitHub API requests are the scarce resource, not time.** Unauthenticated is 60/hour *total*.
  The obvious "list commits, then GET each commit for its stats" design costs one request per
  commit — 80+ for a small repo, which exhausts the whole budget in a single scan. `fetchCommits`
  uses GraphQL (one request per 100 commits, *with* additions/deletions) when a token is present
  and the REST list otherwise. **A scan is 3 requests.** Keep it that way; check
  `https://api.github.com/rate_limit` when calls start failing with 403.

---

## Bugs worth remembering

Each was a confidently-wrong result that looked correct until tested against real code.

- **Barrel files read as dead code.** Re-export targets (`export * from "./x"`) live on oxc's
  *export* records, not `staticImports`. Missing them made every barrel's targets look orphaned.
- **Monorepo entry points read as dead code.** Entry-point patterns were anchored to the repo root,
  so `packages/*/src/index.ts` matched nothing.
- **`react` reported as an unused dependency.** The modern JSX transform uses it without an import.
- **Workspace dependencies reported as unused.** After moving to a real resolver they resolve
  *internally*, so they never appeared in `externalPackages`.
- **A bare `test.js` counted as authored source.** Small packages keep their whole suite there. The
  report simultaneously claimed "no tests" and flagged duplication inside the test file.
- **Only Jest/Vitest assertions were recognised.** Every AVA, tape, and `node:test` project read as
  "asserts nothing at all".
- **Nested tsconfig path aliases were ignored.** Only the scan root's tsconfig was read, so in a
  monorepo `@/…` imports failed to resolve and their targets looked orphaned. Resolvers are now
  pooled per tsconfig and chosen by nearest ancestor.
- **`next-env.d.ts` counted as authored source.** Framework-emitted ambient declarations are never
  imported and never written by a human.
- **Every file in every Python repo read as unreachable.** `ImportGraph` resolves JS/TS only, so
  Python files have no edges at all — and `orphan-files` scored that absence as 1.00, pushing every
  Python project toward "AI-generated".
- **A tsconfig that `extends` an uninstalled package killed all import resolution.** We never run
  `npm install`, so `"extends": "@sindresorhus/tsconfig"` cannot load its base and oxc-resolver
  fails *every* resolution against that config with "Tsconfig not found". On `sindresorhus/ky` that
  meant 0 internal edges from 206 imports, so 29 of 30 files read as dead code. `ResolverPool` now
  falls back to a tsconfig-free resolver. Extending a shared config is common, so this affected a
  large share of real TypeScript repos.
- **A few agent commits in a long history read as "certain".** `agent-trailers` saturated at 0.6 on
  any hit. `colinhacks/zod` has 10 agent-attributed commits out of 2,612 from drive-by
  contributors, and scored 32/100 at `certain` confidence. The value now scales with the attributed
  *share* below 10%, and `scoreDimension` requires a ground-truth signal ≥ 0.6 before claiming
  `certain` — evidence that agents *touched* a repo is not evidence the repo is agent-written.
- **devDependencies reported as unused.** `rollup`, `size-limit`, `xo`, `c8` are CLI tools invoked
  from scripts and config, never imported. Only `runtimeDependencies` is checked now — an unused
  *runtime* dep is the real tell.
- **A top-level `test/` directory matched nothing.** The pattern required a leading separator, so
  `test/benchmark.js` at the repo root counted as authored source. Same anchoring mistake as the
  bare `test.js` case above.
- **Destructured assertions read as no assertions.** `import { equal } from 'node:assert'` binds a
  name matching no known assertion root, so all 52 of `ai/nanoid`'s tests reported "assert nothing
  at all". Local bindings imported from assertion modules now count.
- **`tsd` type tests read as dead code.** `test-d/*.test-d.ts` matched no test pattern, so on
  `sindresorhus/execa` 151 of 261 files counted as authored source that nothing imports —
  `orphan-files` maxed at 1.00 and health scored 22 on a well-kept repository. Nothing is *meant*
  to import a type test; `tsd` reads them directly. Fourth entry in the same family as the bare
  `test.js` and top-level `test/` cases: **a test convention we do not recognise becomes a finding
  about dead code.**
- **Go's `_test.go` files counted as authored source.** The `_test\.pyi?$` pattern was
  Python-only, so Go's toolchain-enforced suffix matched nothing. Seen on `spf13/cobra`: *every*
  clone family was in a `_test.go` file and `duplicate-logic` read **0.80** on a well-regarded
  hand-written library. After the fix, 594 functions drop to 205 and the surviving families are
  genuine — three parallel shell-completion generators. Fifth instance of the same mistake.
- **Rust's inline `#[cfg(test)]` modules counted as source.** Path-based test detection cannot see
  tests that live at the bottom of the module they test, which is Rust's dominant convention. Seen
  on `BurntSushi/ripgrep`, where table-shaped test functions inside genuine source files
  (`crates/core/flags/defs.rs`) drove `duplicate-logic` to 0.57. Clone detection now skips items
  annotated `#[cfg(test)]` / `#[test]`; 1,524 functions drop to 1,010. **Attributes are siblings of
  the item they annotate, not children**, so this walks ordered children rather than using
  `collectNamed`.
- **No HTTP route was ever found in a monorepo.** Both Next patterns were anchored to the scan
  root (`/^(?:src\/)?app\/…/`), so `apps/web/src/app/api/scans/route.ts` matched nothing. Seen on
  `suhail-commits/repo-audit` — this tool reported 0 routes in its own repository, which has one.
  Third instance of the same root-anchoring mistake, after monorepo entry points and top-level
  `test/`. The segment is now matched anywhere in the path, still exactly (`my-app/` does not
  match). **This one hid for a long time because nothing consumed the route count** — it surfaced
  only when the Security section started printing it.
- **`build-velocity` was a rate with neither a real numerator nor a real denominator.** It divided
  `files.totalSloc` — the repo's size *today* — by the number of days that happened to carry a
  commit, so a two-year project with commits on 40 distinct days reported `totalSloc / 40` as a
  daily rate. And `Math.max(1, activeDays)` turned a single day into a divisor. Seen on
  `suhail-commits/repo-audit`: hand-written across one dense day, it read 1.00 and carried the
  score to 26. Now measures `Commit.linesAdded` and reports unavailable below 3 active days.
  **Every other signal already guarded its sample size; this one guarded only its numerator**
  (`sloc < 200`). When adding a ratio, guard both ends.

- **`swallowed-errors` read deliberate swallows as careless ones.** `catch (_err) {}` is the
  near-universal convention for "considered and dropped" — it is ESLint's own default for
  intentionally-unused bindings. Seen on `colinhacks/zod`, whose benchmarks time the throwing path
  that way: 28 of 59 handlers counted as discarded, the signal read 0.72, and the repo hit **30/100
  — the exact number this project calls a bug rather than a result**. Underscore bindings now count
  as declared intent, the same as a comment inside the handler; zod drops to 1 of 59. The fix was
  to read a convention the signal was blind to, **not** to raise the threshold until the number
  went away.

- **Every `pages/api` route counted as state-changing.** Next's Pages API has no per-verb export,
  so `RouteTable` records it as `method: "ALL"` — and `ALL` was in `unauthenticated-routes`'
  mutating set. Seen on `colinhacks/zod`, whose `packages/docs/pages/api/_og.tsx` renders an Open
  Graph *image* and was reported as an unprotected state-changing route. **The only security
  finding the twenty-repo sweep has ever produced, and it was ours.** An `ALL` route now counts
  only when its body mentions a mutating verb, which is how such a handler decides what to do.

- **Every transitive package read as shipped production code.** `devOnly` was decided by asking
  whether a name appeared in a `package.json` — which is true of no transitive package at all, so
  they all defaulted to "ships". `esbuild` and `vite`, which reach this repository only through
  `vitest`, were reported as production dependencies. Fixed by walking pnpm's `importers:` roots
  through the `snapshots:` edges. **This is the whole difference between a useful dependency check
  and `npm audit`.**

- **The lockfile graph walk silently found nothing.** The snapshot-key pattern was `/^ {2}…/`,
  which matches *at least* two leading spaces — so the four-space `dependencies:` line matched it
  too, was taken for a package key, and skipped. Not one edge was ever recorded, the walk reached
  only direct dependencies, and every transitive package fell through to the default. **Nothing
  threw and no test failed.** When anchoring on indentation, anchor both ends: `/^ {2}(?! )/`.

- **`splitNpmSpec` read the wrong `@`.** pnpm writes `next@16.3.0(react@19.2.8)`, and taking the
  last `@` of the raw string lands *inside* the peer suffix, producing the package name
  `next@16.3.0(react`. Most entries in a real pnpm lockfile became names OSV would never match,
  with nothing to indicate a problem. Strip the parenthesised suffix first.

- **Clone detection reported one-line helpers as duplication.** `MIN_NODES` was 18 for JS/TS, and an
  annotated TypeScript one-liner reaches about 19 named nodes once its parameter types, return type
  and any inner arrow are counted. So **all eight Code health findings on this repository were pairs
  of trivial guards** — `isTestFile` and `isGeneratedPath`, both `return PATTERNS.some((p) =>
  p.test(relPath))`; `importsOf` and `importersOf`; `authorshipBand` and `healthBand`. Each really
  is the same shape, and saying so is useless. Raised to **30**, matching Go and Rust, which were
  already there for exactly this reason. This repo drops 15 duplicated functions to 2 and the
  survivor is genuine; the corpus max moves 25 → 24, so real clones are still found. **Found by
  reading the report this tool writes about itself** — no test failed and no sweep number was out of
  range.

- **Our own documented workaround read as an unused dependency.** `tree-sitter-wasms` is loaded
  through a specifier assembled at runtime — `["tree-sitter-wasms","out",name].join("/")` — because
  handing Turbopack a literal makes it try to bundle a `.wasm`. That produces no import record, so
  `unused-dependencies` flagged it. `unusedDependencies` now also accepts packages named in a string
  literal anywhere in the source, **matched with a surrounding quote**: a bare `includes(name)` would
  match `ms` inside "items" and "forms", and short package names are common.

- **A committed private key was invisible.** `deploy/id_rsa` has no extension and matched nothing
  in `isRelevantFile`, so the file was never indexed and the secret scanner could not see the one
  thing it most exists to find. `.pem`, `.key` and the `id_*` filenames are now read.

- **`LICENSE` was never indexed either.** Same shape as the key above, found while building the
  licence checks rather than after shipping them: no extension, in no filename list, so
  `isRelevantFile` rejected it and the file never reached `FileIndex`. Had the check shipped first,
  it would have reported "no licence" on every repository in existence and looked like a working
  signal doing its job. `isLicenseFile` now matches `LICENSE`/`LICENCE`/`COPYING`/`NOTICE` with an
  empty, `.md`, `.txt` or `.rst` extension — **constrained on extension deliberately**, or a source
  file named `license.ts` becomes the project's terms. **Second instance of "the file the check most
  exists to read is the one the index cannot see".** When adding a check, confirm its input is
  indexed before trusting that it found nothing.

The pattern: **a signal that cannot see something reports its absence as a finding.** When adding a
signal, ask what it looks like on a codebase that legitimately does things differently.

A second pattern, all four of the dependency bugs above: **a parser that silently produces nothing
looks exactly like a repository with nothing to find.** Every one of them passed the type checker
and the test suite. What caught them was printing the intermediate values and reading them.

## Investigated and rejected

Kept so nobody spends the afternoon again.

- **Lockfile churn does not distort `commit-size`.** `index/git.ts` sums every file into `churn`
  with no filtering, so a regenerated `pnpm-lock.yaml` counts. Measured across all 18 sweep repos:
  excluding lockfiles and generated paths changed the signal value by **0.000 everywhere**. Median
  commit churn is 6–63 lines on every one of them, far below the 80-line ramp floor, so the outlier
  commits lockfiles inflate never move the median. That is what a median is for.
  **But the aggregate effect is enormous** — 88% of `ai/nanoid`'s total churn is lockfile or
  generated output, 68% of `vercel/ms`, 67% of `pmndrs/zustand`. Any future signal using *mean* or
  *total* churn must exclude them; the median one does not need to.
- **`commit-size` firing on this repository is not a bug.** The median commit here really is
  ~500 lines. Leave it.
- **Two of GitClear's three findings do not survive as per-repository signals.** GitClear's 211M-line
  study is the best external validation this project has — code-block duplication up ~8× and
  error-masking constructs up 47% independently confirm `duplicate-logic` and `swallowed-errors`.
  Three more of its findings looked portable. **Measured across all 20 sweep repos before building
  anything, two are not:**
  - **Early rework** (share of a file's initial lines deleted again within 14 days) reads **0.003 to
    0.814 on hand-written code** — `colinhacks/zod` 0.814, `debug-js/debug` 0.565, `ai/nanoid` 0.536
    against `remeda` 0.027 and `p-limit` 0.003. There is no threshold that keeps zod quiet and still
    ever fires. GitClear saw a 3.1% → 5.7% shift *in aggregate across millions of commits*; at
    single-repository scale the quantity is dominated by how the project happens to work.
  - **Reuse density** (internal `ImportGraph` edges per JS/TS source file) reads **0.00 on
    `debug-js/debug`** — a hand-written library sitting at the maximally-generated end of the scale,
    because it is CommonJS and `require()` produces no static import records. The same blind spot as
    every other entry here: *a signal that cannot see something reports its absence as a finding.*
    Not shippable without CJS resolution.
  - **Refactor ratio** (`deleted / churn` of the median commit) is the one that holds: **0.333–0.500
    across all 20**, tightly clustered, with 9 of them at 0.40–0.50. But **this repository reads
    0.085**, far below the corpus floor — truthfully, because it is 20 commits over two days and has
    had no occasion to delete anything yet. So it needs a maturity guard in the shape of
    `build-velocity`'s: a project too young to have refactored is a point, not a measurement.
  **Also measured and discarded: a cross-file "moved lines" estimator** — `min(shed, gained)` within
  a commit — reads **exactly 0.000 on all 20** at the median, because most multi-file commits are
  net-additive in every file they touch. Its aggregate form varies (0.015–0.256) but divides by
  *total* churn, which is the lockfile trap recorded above.

- **A `doc-style` signal cannot be validated with the corpus we have.** README tells were measured
  across all 18 sweep repos before building anything. Every candidate fires on hand-written work:
  `sindresorhus/execa` has emoji on **50%** of its README bullets, `encode/httpx` runs 3.64
  superlatives per 1,000 words, `remeda/remeda` hits 4 of 7 boilerplate headings. The one tell that
  looks clean — emoji in headings, 0% across all 18 — is clean because the corpus is eighteen
  utility libraries by a handful of authors, not because emoji headings are rare in hand-written
  READMEs. Three of the repos have no real README at all.
  **The deeper problem is that the corpus is one-sided.** It can show a signal stays quiet on
  hand-written code; it cannot show one fires on generated code, because there is no labelled
  AI-written corpus here. For structural signals the synthetic fixtures cover that side. For prose
  they cannot. Shipping would mean shipping a signal whose true-positive behaviour was never
  measured, aimed at the single most-read file in a repository.

---

## Current state

Built and passing (244 tests): GitHub API ingest, index layer, 16 authorship signals, an 8-signal
health dimension (calibrated), a 7-signal security dimension,
tiered multi-language analysis, scoring, narrator with three personas, and a Vercel-ready web app
that scans inline with no worker or queue.

**The report shows all three sections at once, and the landing page asks nothing but the
repository.** It used to open with a three-way picker — vibe check, security, or code health — which
never controlled which analyzers ran (a scan always produces all three; the indexes are shared) and
only chose which section the page opened on. So it was a question with no wrong answer, asked before
anyone had seen the product, whose sole effect was to hide two thirds of an answer already computed.
`ScanRecord.focus` is still written and still validated on read, because rows carry it; nothing
reads it to decide anything.

With three sections on one page the repeated furniture became the bulk of it, so **the directory
ranking, the raw metrics and the per-check breakdown live behind one `<details>` per section**. The
two rankings in particular came out nearly identical — health borrows the same per-file data
authorship measured — so the same six folders printed twice in a slightly different order.
`RepoInfo.headSha` and the facts strip at the top exist because nothing said *which revision* was
analysed: the same project read 11,436 lines locally and 7,519 through the API on one afternoon,
because one had unpushed commits, and the page gave the reader no way to account for it.

**The report ranks across sections and says where a score lands.** `NarratedReport.priorities` is
the shortlist above the sections — every actionable finding from all three dimensions, ordered by
severity then confidence, **one entry per rule** and capped at five. The dedupe is what makes it
useful: clone detection emits one finding per family, and without it four of five slots read
"near-identical copies of the same function" and four different problems fell off the list. It
ranks and filters findings the analyzers already emitted; it never originates one.

`CORPUS_BASELINE` (`packages/shared/src/corpus.ts`) carries the sweep's score distribution so the
report can answer "is 21 a lot?". **Generated by `pnpm sweep --emit-baseline`, never hand-edited** —
a hand-maintained copy drifts from the corpus it claims to describe and nothing fails when it does.
Two rules bind the prose in `packages/rules/src/corpus.ts`: it always says *hand-written*
repositories, because that is the only population the corpus samples, and it never turns a standing
into a verdict. Security scores 0 across all twenty, so that dimension has **no spread at all** and
gets a different sentence — run through the ordinary branches, any finding whatsoever printed
"higher than any of the 20 we compared against", which is "you have at least one finding" dressed
up as a percentile.

**The report is three dimensions**: `authorship` (the vibe check), `security`, `health`. `health`
absorbed what were separate `quality` and `architecture` dimensions — they asked the same question
and split into two thin sections instead of one substantial one.

All three dimensions carry a score, and **all three run the same direction — higher means more of
what was measured**, so the health bars still sum to the health score. Inverting health so 85 reads as "healthy" would make the bars sum to `100 − score`
and cost the breakdown its whole argument. The band words carry the direction instead
(`solid` / `minor issues` / `rough` / `poor`).

The six structural signals (duplication, dead code, obvious comments, tautological tests, unused
deps, overlapping utils) feed authorship as *evidence* while the same measurements, re-weighted,
feed health as *defects*. **`analyzeHealth` borrows the `Signal` objects from the authorship pass
and replaces only their weights** — recomputing would double the cost of clone hashing and, worse,
would let the same measurement print two different numbers in two sections.

**Security signals are presence-shaped, and that is the one deliberate departure** from how the
other two dimensions work. Every authorship and health signal is a ratio, because those questions
are proportional. Security is not: one committed AWS key in a 500-file repo is a ratio of 0.002,
which scores ~0 and renders as *solid*. So `hardcoded-secrets` and `committed-env` saturate on
their first hit and the count lives in the finding. `unauthenticated-routes` stays a real
proportion — "half the mutating routes are open" differs from "one is" — and `dangerous-calls` and
`vulnerable-dependencies` ramp, because every large dependency tree carries some advisory.

The consequence is a jumpier score than the other sections have, so **the section headline comes
from the worst finding, not the score**: 8/100 with a live credential is still critical.

Each dimension owns its band words, and security's label a *quantity* rather than a verdict
(`nothing found` / `some` / `several` / `widespread`). Borrowing health's would print "solid" beside
a leaked key; the authorship words, which security used by default, printed **"21 out of 100 —
unlikely"** on the scale — an answer to a question nobody asked. The judgement lives in the
headline, which is why the scale is free to describe only how much was measured.

`vulnerable-dependencies` is the only analysis in the engine that reaches the network, so it is
**off by default** and opted into by the CLI (`pnpm scan`, disable with `--offline`) and the web
app. Registered either way: switched off it reports unavailable rather than vanishing, so its
weight is not silently redistributed.

**Licensing lives inside Security**, as `missing-license` and `license-mismatch`, rather than as a
fourth dimension — it is the same kind of question (what does this repository expose that its owner
may not know about?) and a fourth tab would have needed its own band vocabulary to say very little.
Both are offline: a text fingerprint over the licence file, compared against the `license` field of
the shallowest `package.json` or `Cargo.toml`. **The other half of the question is not answered.**
Dependency licences would cost one registry request per package — hundreds inside a single scan,
with no batch API to avoid it — so the scan emits a warning saying so rather than leaving the
reader to assume they were checked.

**Two shareable surfaces.** `GET /api/badge/<owner>/<repo>.svg` renders the authorship score as a
README badge — hand-written SVG, no shields.io call and no dependency, since a badge service would
put someone else's uptime in front of every README carrying one. It **never triggers a scan**: an
`<img>` is fetched by every crawler and preview renderer that touches the page, so a repository
nobody has scanned gets a badge saying exactly that. And `ScanResult.moduleGraph` drives a module
map in the report, aggregated to directories from edges `ImportGraph` already resolved, capped at
12 nodes with the remainder counted out loud. Both are **one neutral colour, never a status ramp** —
colouring a high authorship score red would assert that AI-generated code is bad, and the badge is
the most quotable surface here.

Not built: BYOK.
`ScanResult.analysedDimensions` names the dimensions an analyzer actually ran for, so the report
can render an unbuilt section as "not analysed yet" instead of as a pass. **Add a dimension to
that array in the same commit that registers its analyzer**; a section that ran and found nothing
is otherwise indistinguishable from one that never looked.

### Deployment shape

Everything runs on Vercel. There is **no `git` binary, no worker, no queue, and no persistent
filesystem** — the tarball is fetched over HTTP into `/tmp` and scanned inline within one request.
`DATABASE_URL` (Neon) and `GITHUB_TOKEN` are the only configuration; both are optional locally and
required in production. See `.env.example`.

`/tmp` is used rather than an in-memory filesystem because `ImportGraph` resolves through
`oxc-resolver`, which performs real filesystem lookups.

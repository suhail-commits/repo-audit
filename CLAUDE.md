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
- Commit at each logical checkpoint — a working, tested unit of change — not once per session and
  not once per file.

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
pnpm scan .          # this repo must score 0-5 with signals reading 0.00
pnpm sweep           # median ~7, max under 30, nothing claiming `certain`
```

`pnpm scan .` is the fastest real check that exists: our own code is hand-written, so any signal
firing on it is a false positive, not a result. That check alone has caught two bugs.

### Deciding versus asking

- **Decide alone** when the choice is reversible, internal, and has a conventional default. State
  the choice in the report and move on.
- **Ask first** when different readings produce materially different work, when the action is
  outward-facing (pushing, deploying, creating a repo), or when it destroys something. There is no
  undo for a delete beyond the last commit, and unpushed commits have no remote copy.
- **When a plan turns out wrong mid-way**, stop and say so rather than forcing the original
  approach through. Report what was learned, propose the correction, and do not quietly widen scope
  to accommodate it.

### Playbook — adding or changing a provenance signal

1. Implement in `packages/engine/src/analyzers/provenance/`, returning a `Signal`. If inputs can be
   missing, return `available: false` with an `unavailableReason` — **never** a value of 0.
2. Register it with a weight in `analyzers/provenance/index.ts`.
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
| full | JS/TS (oxc) | all 13 |
| structural | Python (tree-sitter) | clones, obvious comments, test assertions, + history |
| history | everything else | trailers, commit shape, velocity, platform |

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

**`pnpm scan .` on this repo is the fastest sanity check.** It should score 0–5/100 with every
available signal reading `0.00`. Any signal that starts firing on our own hand-written code is a
false positive to investigate, not a result — that check has already caught two real bugs.

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

Current baseline: **median 7, max 19, none above 30, none claiming `certain`.**

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

The pattern: **a signal that cannot see something reports its absence as a finding.** When adding a
signal, ask what it looks like on a codebase that legitimately does things differently.

---

## Current state

Built and passing (91 tests): GitHub API ingest, index layer, 13 provenance signals (calibrated),
tiered multi-language analysis, scoring, narrator with three personas, and a Vercel-ready web app
that scans inline with no worker or queue.

Not built: security analyzer (`auth-coverage` and friends), quality analyzer, architecture
analyzer, BYOK. `ScanResult.architecture` deliberately returns `insufficient-evidence` rather than
a fabricated verdict.

### Deployment shape

Everything runs on Vercel. There is **no `git` binary, no worker, no queue, and no persistent
filesystem** — the tarball is fetched over HTTP into `/tmp` and scanned inline within one request.
`DATABASE_URL` (Neon) and `GITHUB_TOKEN` are the only configuration; both are optional locally and
required in production. See `.env.example`.

`/tmp` is used rather than an in-memory filesystem because `ImportGraph` resolves through
`oxc-resolver`, which performs real filesystem lookups.

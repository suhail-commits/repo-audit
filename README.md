# Repo Audit

Paste a public GitHub repository and get a report on how much of it was written by AI, with the
evidence for that claim.

No model is asked for an opinion. Every number comes from parsing the code and reading the commit
history, so the same repository always produces the same report and every sentence traces back to
something measured.

```
This app was probably built largely with AI coding tools.

PROVENANCE — 64/100
  • Lovable: depends on `lovable-tagger`.
  • 1 of 3 commits carry AI agent attribution.
  • 16 of 25 comments (64%) restate the line directly below them.
  • 8 of 11 declared dependencies are never imported.

[MEDIUM] 4 near-identical copies of the same function
  The same logic has been written 4 separate times, under different names
  (renderDate, prettyDate, displayDate and formatDate).
  → When one copy needs a fix, the others are easy to miss — so a bug you
    thought was fixed can keep happening.
```

---

## How it decides

Sixteen signals, weighted and combined. They fall into three groups.

**Direct evidence.** Commit trailers (`Co-Authored-By: Claude`, Cursor, Copilot, Devin) and AI
builder fingerprints (Lovable's `lovable-tagger`, Bolt's `.bolt/`, Replit, v0). When these fire the
project is telling us who wrote it, so the report says `certain` rather than dressing up a guess.

**History shape.** Median commit size, message entropy, lines per author per active day, and the
proportion of files created once and never touched again. Hand-written repositories accumulate in
small, irregular commits over many days. Agent-built ones land in a few very large commits over
very few days, with low-information messages, and most files are never revisited.

**Structure.** This is the group that works with no git history at all:

- **Type-2 clone detection.** Each function's AST is normalised — identifiers become `$`, literals
  become `#` — and the resulting node-type sequence is hashed. Two functions with the same shape
  and different names collide. This catches the characteristic agent failure of rewriting a helper
  it has no memory of writing, so a project ends up with `formatDate`, `prettyDate` and
  `displayDate` doing the same thing in three files.
- **Convention drift.** Each file gets a vector of choices — error-handling idiom, async style,
  export style, function declaration style — and the signal measures how much files *disagree*. One
  author converges on habits; one file per session does not. Formatting-only dimensions are dropped
  when the project has a formatter, since Prettier flattens them regardless of who wrote the code.
- **Narrating comments.** A comment whose words merely restate the identifiers on the line beneath
  it (`// fetch the user` above `const user = await fetchUser(id)`).
- **Abandoned scaffolding.** Dependencies never imported, files nothing reaches, several
  overlapping `utils`/`helpers`/`lib` modules exporting the same names.
- **Tautological tests.** Tests that assert nothing, or assert only that a mock they configured was
  called — which cannot fail when the code under test is wrong.

## Three ideas that make the output trustworthy

**A missing signal lowers confidence, never the score.** Unavailable signals are excluded and their
weight redistributed across the rest. Scoring a missing signal as zero would make a repository with
no commit history look *cleaner* than the same repository with it — exactly backwards. Instead the
score covers what could be measured, and the report names what could not.

**Calibration withholds the ground-truth signals.** The separation test runs with commit trailers
and platform fingerprints disabled, so it proves the *structural* signals distinguish agent-built
from hand-written code. Passing it by grepping for `Co-Authored-By: Claude` would demonstrate
nothing.

**Analysis depth is tiered and stated.** Every repository gets a real verdict; the report says how
deep it could go.

| Tier | Languages | What runs |
|---|---|---|
| Full | JavaScript, TypeScript | all sixteen signals |
| Structural | Python, Go, Rust | duplication and comment narration, plus history; Python also gets test assertions and swallowed errors |
| History | everything else | commit trailers, commit shape, velocity, platform markers |

A language we cannot parse is a gap in the evidence, not a clean bill of health, and the report
never lets the two look the same.

## False positives found on real repositories

The synthetic fixtures passed while every one of these was live. They are recorded because the
pattern connecting them is the main thing to understand about building this kind of tool.

| What broke | Why |
|---|---|
| Barrel files read as dead code | Re-export targets live on the parser's *export* records, not its imports |
| Every monorepo package's `index.ts` read as dead code | Entry-point patterns were anchored to the repo root |
| `react` reported as an unused dependency | The modern JSX transform uses it without an import |
| A bare `test.js` counted as authored source | The report claimed "no tests" while flagging duplication *inside* the test file |
| Every AVA / tape / `node:test` project read as "asserts nothing" | Only `expect()` was recognised |
| Every file in every Python repo read as unreachable | The import graph only resolves JS/TS, so Python files have no edges |

**The pattern: a signal that cannot see something reports its absence as a finding.** Each of these
was a confidently wrong answer that looked entirely plausible until it met real code.

The engine is also pointed at itself. It does **not** score near zero, and the reason is the point:
`CLAUDE.md` sits in the repository, the median commit really is around 465 lines, and the one
state-changing route really is public by design. Each of those is a true measurement of a
deliberate choice. What matters is that the list of signals firing is known and short — a signal
that starts firing outside it is treated as a bug rather than a result, and that check has already
caught two real false positives.

## Architecture

```
packages/shared   types and score bands       (no dependencies)
packages/engine   all analysis                (shared)
packages/rules    report prose, personas      (shared)
packages/cli      the terminal product        (all three)
apps/web          Next.js UI                  (all three)
```

The engine is a pure function of a directory path and has no web framework in it. Its pipeline is
`ingest → index → analyze → score → render`, and the index layer is the load-bearing decision:
every file is parsed exactly once and all analyzers read from shared indexes.

Two seams do most of the structural work:

- **`Commit[]`** — every history signal reads only this array, so `GitIndex.build(path)` (local
  `git log`) and `GitIndex.fromCommits()` (GitHub API) are interchangeable. Moving off `git clone`
  changed no analyzer.
- **`Narrator`** — the engine emits structured findings; a narrator turns them into prose. The
  template implementation is deterministic; anything else can be substituted behind the interface.

**Parsing.** JS/TS uses [oxc](https://oxc.rs) rather than tree-sitter, chosen for its static module
record — imports, exports and re-exports computed in Rust — and for real ESTree semantics. Python
uses tree-sitter via WASM. A benchmark of both on this repository's own source is in the commit
history: oxc parses ~6× faster, and about 5× faster again on repeated traversal, though at this
scale neither is the bottleneck.

**Reports have three registers** — owner, engineer, and buyer — rendered from the same `ScanResult`,
so switching between them costs nothing.

## Install it

```bash
npx how-much-ai .                        # scan a checkout, no clone needed
npx how-much-ai                          # or let it ask
```

Node >= 22.12. The command installs as `repo-audit`.

**Only Windows is verified.** The parser ships a different native binary per
platform and this package has no CI yet, so macOS and Linux are untested rather
than known-good. `repo-audit --selftest` reports which parsers and grammars
actually loaded on your machine, and exits non-zero if any did not — that output
is the useful thing to include in a bug report.

## Running it from source

```bash
pnpm install
pnpm repo-audit .                        # the narrated report for a local checkout
pnpm repo-audit owner/repo               # …or a public GitHub repository
pnpm repo-audit . --signals              # every signal, its weight and its evidence
pnpm repo-audit                          # no arguments: it asks which repo and branch
pnpm repo-audit a/b --branch develop     # a specific branch (GitHub repositories only)
pnpm repo-audit --help                   # everything else
pnpm vitest run                          # the test suite
pnpm web                                 # the app, on :3000
```

`pnpm scan` and `pnpm report` still work; they are aliases for `pnpm repo-audit --signals` and
`pnpm repo-audit`. The script is **not** called `audit`: `pnpm audit` is a built-in pnpm command
and silently shadows any script of that name, so it would never have run this one.

**A local checkout is read at full strength, and the hosted app cannot be.** GitHub's API returns
per-*commit* totals but no per-*file* changes, and fetching those costs one request per commit —
enough to exhaust the entire hourly budget on a single scan. So `write-once-files` reports itself
unavailable on every API-sourced scan, and without a token `commit-size`, `build-velocity` and
`refactor-ratio` go with it: 23 of 30 points of authorship evidence, which caps confidence at
*medium*. Scanning the directory on your disk has none of that, reads code that never leaves your
machine, and is not bounded by a serverless memory limit. The report says which checks ran either
way.

Both environment variables are optional locally and required in production — see `.env.example`.
Without `DATABASE_URL` the app keeps scans in memory; without `GITHUB_TOKEN` you share a 60
requests/hour limit with every other unauthenticated caller.

A scan costs **three** GitHub API requests. The obvious design — list commits, then fetch each one
for its line counts — costs one request per commit, which exhausts the entire unauthenticated
budget on a single medium repository. GraphQL returns history *with* additions and deletions in one
request per hundred commits.

## Safety

The scanner processes untrusted repositories and **never executes their code** — no install, no
build, no test run, no git hooks. Archives are extracted with path-traversal rejection, symlink
rejection, and expansion caps; oversized repositories are refused up front rather than being allowed
to exhaust a function timeout.

## What this cannot see

Worth stating plainly, because a scanner that hides its blind spots is worse than one that names
them.

**It only reads what is committed.** Plenty of people gitignore `CLAUDE.md` or `.cursorrules`. Those
repositories look untooled to us, because from the outside they are.

**It is not adversarial-proof.** Delete the agent config, strip the commit trailers, and the two
strongest signals go quiet. The structural ones — duplicated logic, comments restating the line
below, convention drift between files — are harder to erase, but nothing here survives someone who
sets out to defeat it. This measures ordinary repositories honestly; it is not a forensic tool.

**A short or squashed history removes four signals.** Commit size, message entropy, build velocity
and write-once files all need a real history. Squash-merge everything, or start version control
last week, and they report unavailable.

**The worked example is this repository.** Before agent-config detection existed, scanning it
returned **0/100, "unlikely to be AI-generated"** — while three agent config files sat tracked in
the tree and every commit deliberately carried no AI attribution. The score was a faithful
measurement of the evidence available and a poor description of reality. Both things are true at
once, and that gap is the honest limit of this approach.

**A low score is not a clean bill of health.** It means the usual patterns were not found. On a
carefully written codebase — whoever or whatever wrote it — that is exactly what you would expect.

## Status

The report is three sections: **authorship** (how much looks AI-written), **security**, and
**health** (duplication, dead code, test quality, structure).

All three are built, and the report shows all three — the landing page asks for a repository and
nothing else. Authorship is complete and calibrated, health is populated from the structural
signals, and security runs seven checks: committed credentials, committed `.env` files, routes that
change data without checking the caller, dangerous calls and wildcard CORS, dependencies with
published vulnerabilities, a missing licence, and a licence file that contradicts the manifest.

All but two work on **any language** — credential formats are vendor-assigned, OSV covers npm,
PyPI, Go and crates.io, and a licence is a licence. The route and sink checks are deliberately
JavaScript and TypeScript only, because they need framework semantics rather than syntax.

Licensing sits inside security rather than in a section of its own: it asks the same question —
what does this repository expose that its owner may not know about — and it is the first thing
technical due diligence looks at. **Dependency licences are not examined**, and the report says so
rather than leaving the reader to assume they were; there is no batch licence lookup, and querying
a registry per package would cost hundreds of requests inside a single scan.

The dependency check is the only analysis that reaches the network, so it is off by default in the
library, on in the app, and disabled with `pnpm scan --offline`. When it cannot reach OSV it
reports unavailable rather than failing the scan — an unreachable database is not a clean bill of
health.

A section with no analyzer renders as **"not analysed yet"** rather than being hidden. An absent
section reads as a clean bill of health, and only one of those is true.
`ScanResult.analysedDimensions` records which dimensions an analyzer actually ran for, because a
dimension that ran and found nothing produces output identical to one that never looked.

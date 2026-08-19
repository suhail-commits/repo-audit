import { afterEach, describe, expect, it } from "vitest";

import { collectStructuralFunctionShapes } from "../analyzers/authorship/clones";
import { analyzeAuthorship } from "../analyzers/authorship/index";
import { isTestFile } from "../ingest/guards";
import { buildContext } from "../scan";
import { createFixtureRepo, type FixtureRepo } from "../testing/fixture-repo";
import { profileLanguages, tierFor } from "./language";
import { probeStructuralParsers } from "./structural";

let repo: FixtureRepo | undefined;
afterEach(() => {
  repo?.cleanup();
  repo = undefined;
});

/** Same shape, different names and literals — a type-2 clone. */
function pyHelper(name: string, sep: string): string {
  return `def ${name}(value):
    parsed = parse_date(value)
    year = parsed.year
    month = parsed.month
    day = parsed.day
    return str(year) + "${sep}" + str(month) + "${sep}" + str(day)
`;
}

/**
 * Structurally distinct function bodies, each using a different control-flow
 * construct. Clone detection erases identifiers and literals, so fixtures that
 * vary only those register as duplicates — correctly.
 */
const PADDING_SHAPES: ((i: number) => string)[] = [
  (i) => `def loop${i}(items):
    total = 0
    for n in items:
        total += n
    return total
`,
  (i) => `def branch${i}(value):
    if value > ${i}:
        return "big"
    elif value < 0:
        return "negative"
    else:
        return "small"
`,
  (i) => `def gather${i}(rows):
    out = {}
    with open("f") as fh:
        for row in rows:
            out[row] = fh.read()
    return out
`,
  (i) => `def guard${i}(payload):
    try:
        value = payload["key"]
    except KeyError:
        return None
    while value > ${i}:
        value -= 1
    return value
`,
];

describe("language profiling", () => {
  it("assigns a tier per language", () => {
    expect(tierFor("typescript")).toBe("full");
    expect(tierFor("python")).toBe("structural");
    expect(tierFor("go")).toBe("structural");
    expect(tierFor("rust")).toBe("structural");
    // Still history-only: a grammar ships for Java, but no structural signal
    // knows its node names, and a grammar that loads is not a language that is
    // analysed.
    expect(tierFor("java")).toBe("history");
  });

  it("weighs languages by lines, not file count", () => {
    // Fifty tiny config files should not make a repo "mostly config".
    const profile = profileLanguages([
      ...Array.from({ length: 50 }, (_, i) => ({
        relPath: `conf/${i}.js`,
        sloc: 2,
      })),
      { relPath: "main.py", sloc: 900 },
    ]);

    expect(profile.dominant).toBe("python");
    expect(profile.dominantTier).toBe("structural");
    expect(profile.shares[0]!.share).toBeGreaterThan(0.85);
  });

  it("names languages it could not parse", () => {
    const profile = profileLanguages([
      { relPath: "Main.java", sloc: 800 },
      { relPath: "util.ts", sloc: 100 },
    ]);

    expect(profile.unparsed).toContain("java");
    expect(profile.dominantTier).toBe("history");
  });
});

describe("Python structural analysis", () => {
  it("detects duplicated Python functions", async () => {
    repo = createFixtureRepo({
      files: {
        "app/a.py": pyHelper("format_date", "-"),
        "app/b.py": pyHelper("pretty_date", "/"),
        "app/c.py": pyHelper("render_date", "."),
        // Padding so the clone signal clears its minimum sample size. These
        // must differ in *control flow*, not just names and literals — the
        // hasher erases those, so varying them would make the padding itself
        // the largest clone family.
        ...Object.fromEntries(
          Array.from({ length: 21 }, (_, i) => [
            `app/mod${i}.py`,
            PADDING_SHAPES[i % PADDING_SHAPES.length]!(i),
          ]),
        ),
      },
      withoutGit: true,
    });

    const ctx = await buildContext(repo.rootPath);
    expect(ctx.structural.parsedCount).toBeGreaterThan(20);

    const { findings } = analyzeAuthorship(ctx);
    // Families are ranked by size, so the date helpers are not necessarily
    // first — look for the family that contains them.
    const dateFamily = findings
      .filter((f) => f.ruleId === "duplicate-function")
      .find((f) => (f.data["names"] as string[]).includes("format_date"));

    expect(dateFamily).toBeDefined();
    expect(dateFamily!.data["names"]).toEqual(
      expect.arrayContaining(["format_date", "pretty_date", "render_date"]),
    );
    expect(dateFamily!.locations.map((l) => l.file)).toEqual(
      expect.arrayContaining(["app/a.py", "app/b.py", "app/c.py"]),
    );
  });

  it("does not report structurally different Python functions as clones", async () => {
    repo = createFixtureRepo({
      files: Object.fromEntries(
        Array.from({ length: 24 }, (_, i) => [
          `app/mod${i}.py`,
          PADDING_SHAPES[i % PADDING_SHAPES.length]!(i),
        ]),
      ),
      withoutGit: true,
    });

    const ctx = await buildContext(repo.rootPath);
    const { clones } = analyzeAuthorship(ctx);

    // Four distinct shapes, each repeated six times. They group by shape rather
    // than collapsing into one family, which is what would happen if the hash
    // were too coarse to tell the control-flow constructs apart.
    expect(clones.families).toHaveLength(4);
    for (const family of clones.families) {
      expect(family.members).toHaveLength(6);
    }
  });

  it("counts pytest assert statements rather than reporting no assertions", async () => {
    repo = createFixtureRepo({
      files: {
        "src/app.py": "def add(a, b):\n    return a + b\n",
        "tests/test_app.py": Array.from(
          { length: 8 },
          (_, i) => `def test_case${i}():\n    result = add(${i}, 1)\n    assert result == ${i + 1}\n`,
        ).join("\n\n"),
      },
      withoutGit: true,
    });

    const ctx = await buildContext(repo.rootPath);
    const signal = analyzeAuthorship(ctx).score.signals.find(
      (s) => s.id === "tautological-tests",
    )!;

    expect(signal.available).toBe(true);
    expect(signal.value).toBe(0);
  });

  it("still catches Python tests that assert nothing", async () => {
    repo = createFixtureRepo({
      files: {
        "src/app.py": "def add(a, b):\n    return a + b\n",
        "tests/test_app.py": Array.from(
          { length: 8 },
          (_, i) => `def test_case${i}():\n    result = add(${i}, 1)\n    print(result)\n`,
        ).join("\n\n"),
      },
      withoutGit: true,
    });

    const ctx = await buildContext(repo.rootPath);
    const signal = analyzeAuthorship(ctx).score.signals.find(
      (s) => s.id === "tautological-tests",
    )!;

    expect(signal.available).toBe(true);
    expect(signal.value).toBeGreaterThan(0.5);
    expect(signal.evidence.join(" ")).toMatch(/assert nothing at all/);
  });

  it("catches mock-only assertions in Python", async () => {
    repo = createFixtureRepo({
      files: {
        "src/app.py": "def add(a, b):\n    return a + b\n",
        "tests/test_app.py": Array.from(
          { length: 8 },
          (_, i) =>
            `def test_case${i}():\n    fake = Mock()\n    fake(${i})\n    fake.assert_called_once()\n`,
        ).join("\n\n"),
      },
      withoutGit: true,
    });

    const ctx = await buildContext(repo.rootPath);
    const signal = analyzeAuthorship(ctx).score.signals.find(
      (s) => s.id === "tautological-tests",
    )!;

    expect(signal.value).toBeGreaterThan(0.5);
    expect(signal.evidence.join(" ")).toMatch(/only assert that a mock/);
  });

  it("flags Python comments that restate the next line", async () => {
    repo = createFixtureRepo({
      files: Object.fromEntries(
        Array.from({ length: 20 }, (_, i) => [
          `app/mod${i}.py`,
          `# fetch the user\nuser${i} = fetch_user(${i})\n\n# save the record\nsave_record(user${i})\n`,
        ]),
      ),
      withoutGit: true,
    });

    const ctx = await buildContext(repo.rootPath);
    const signal = analyzeAuthorship(ctx).score.signals.find(
      (s) => s.id === "obvious-comments",
    )!;

    expect(signal.available).toBe(true);
    expect(signal.value).toBeGreaterThan(0.5);
  });

  it("does not report every Python file as unreachable", async () => {
    // ImportGraph only resolves JS/TS, so Python files have no edges. Judging
    // reachability anyway made every file in every Python repo look orphaned —
    // the signal reporting its own blindness as a finding.
    repo = createFixtureRepo({
      files: Object.fromEntries(
        Array.from({ length: 20 }, (_, i) => [
          `app/mod${i}.py`,
          `def thing${i}():\n    return ${i}\n`,
        ]),
      ),
      withoutGit: true,
    });

    const ctx = await buildContext(repo.rootPath);
    const signal = analyzeAuthorship(ctx).score.signals.find(
      (s) => s.id === "orphan-files",
    )!;

    expect(signal.available).toBe(false);
    expect(signal.value).toBe(0);
    expect(signal.unavailableReason).toMatch(/JavaScript and TypeScript/);
  });

  it("reports the analysis tier and what could not be parsed", async () => {
    repo = createFixtureRepo({
      files: {
        "main.go": "package main\n\nfunc main() {\n\tprintln(\"hi\")\n}\n".repeat(30),
        "helper.py": "def helper():\n    return 1\n",
      },
      withoutGit: true,
    });

    const ctx = await buildContext(repo.rootPath);
    // Go is parsed structurally now; this fixture is here to prove the tier is
    // reported from what actually ran, not from a hardcoded table.
    expect(ctx.languages.dominant).toBe("go");
    expect(ctx.languages.dominantTier).toBe("structural");
    expect(ctx.languages.unparsed).not.toContain("go");
  });

  it("parses Go and Rust structurally, tagging each tree with its language", async () => {
    repo = createFixtureRepo({
      files: {
        "main.go": "package main\n\nfunc main() {\n\tprintln(\"hi\")\n}\n".repeat(20),
        "lib.rs": "pub fn add(a: i32, b: i32) -> i32 {\n    a + b\n}\n".repeat(20),
        "helper.py": "def helper():\n    return 1\n",
      },
      withoutGit: true,
    });

    const ctx = await buildContext(repo.rootPath);
    expect(ctx.structural.get("main.go")?.language).toBe("go");
    expect(ctx.structural.get("lib.rs")?.language).toBe("rust");
    expect(ctx.structural.get("helper.py")?.language).toBe("python");
    // Three grammars in one scan, each cached separately.
    expect(ctx.structural.available).toBe(true);
  });

  it("treats Go's `_test.go` files as tests", async () => {
    /*
     * Seen on `spf13/cobra`: every one of its clone families lived in a
     * `_test.go` file and `duplicate-logic` read 0.80 on a well-regarded
     * hand-written library. The suffix is enforced by the Go toolchain itself.
     * Fifth instance of the same mistake as bare `test.js`, top-level `test/`
     * and `tsd` type tests.
     */
    expect(isTestFile("command_test.go")).toBe(true);
    expect(isTestFile("pkg/args_test.go")).toBe(true);
    // Not every file with "test" in the name is one.
    expect(isTestFile("pkg/latest.go")).toBe(false);
    expect(isTestFile("pkg/testing.go")).toBe(false);
  });

  it("excludes Rust's inline `#[cfg(test)]` modules from clone detection", async () => {
    /*
     * Seen on `BurntSushi/ripgrep`, whose tests live at the bottom of the module
     * they test. Path-based test detection cannot see those, so table-shaped
     * test functions inside genuine source files counted as duplicated logic.
     */
    const body = (n: number) =>
      [
        `pub fn real${n}(a: i32, b: i32) -> i32 {`,
        `    let mut total = a;`,
        `    if b > ${n} { total += b; }`,
        `    for i in 0..${n} { total += i; }`,
        `    total`,
        `}`,
      ].join("\n");

    // Six identically-shaped test functions, and six distinct real ones.
    const tests = Array.from({ length: 6 }, (_, i) =>
      [
        `    #[test]`,
        `    fn case${i}() {`,
        `        let value = real${i}(1, 2);`,
        `        assert_eq!(value, ${i});`,
        `    }`,
      ].join("\n"),
    ).join("\n");

    repo = createFixtureRepo({
      withoutGit: true,
      files: {
        "lib.rs": [
          ...Array.from({ length: 6 }, (_, i) => body(i)),
          "",
          "#[cfg(test)]",
          "mod tests {",
          "    use super::*;",
          tests,
          "}",
        ].join("\n"),
      },
    });

    const ctx = await buildContext(repo.rootPath);
    const shapes = collectStructuralFunctionShapes(ctx.structural.get("lib.rs")!);

    expect(shapes.length).toBeGreaterThan(0);
    expect(shapes.map((s) => s.name).filter((n) => n.startsWith("case"))).toEqual(
      [],
    );
  });

  it("still reports a language with no grammar as history-only", async () => {
    // A grammar ships for Java and loads fine. That is not the same as Java
    // being analysed, and the report must not imply it is.
    repo = createFixtureRepo({
      files: {
        "Main.java": "class Main {\n  void run() { System.out.println(1); }\n}\n".repeat(30),
      },
      withoutGit: true,
    });

    const ctx = await buildContext(repo.rootPath);
    expect(ctx.languages.dominantTier).toBe("history");
    expect(ctx.languages.unparsed).toContain("java");
  });
});

describe("probeStructuralParsers", () => {
  /*
   * The guard against a build that silently lost its grammars.
   *
   * `StructuralIndex` only ever loads a grammar for a language the scanned
   * repository actually contains, so a broken install looks perfectly healthy
   * on a JavaScript repo and fails only on someone else's Python one. This
   * probe asks all three regardless, which is what makes it usable as the
   * assertion for a packaged build.
   */
  it("loads and parses every grammar the build ships", async () => {
    const probes = await probeStructuralParsers();

    expect(probes.map((p) => p.language).sort()).toEqual(["go", "python", "rust"]);

    const failed = probes.filter((p) => !p.ok);
    // Named in the message so a failure says which grammar and why, rather
    // than "expected 0 to be 3".
    expect(
      failed.map((p) => `${p.language}: ${p.reason}`),
      "every shipped grammar must load",
    ).toEqual([]);
  });

  it("reports a real reason rather than swallowing the failure", async () => {
    // Not a file-existence check: a grammar that loads but yields no named
    // nodes is also a failure, which is how an ABI mismatch would present.
    const probes = await probeStructuralParsers();
    for (const probe of probes) {
      if (!probe.ok) expect(probe.reason).toBeTruthy();
    }
  });
});

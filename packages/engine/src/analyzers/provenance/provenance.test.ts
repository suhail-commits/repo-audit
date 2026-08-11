import { afterEach, describe, expect, it } from "vitest";

import { buildContext } from "../../scan";
import {
  createFixtureRepo,
  type FixtureCommit,
  type FixtureRepo,
} from "../../testing/fixture-repo";
import { analyzeProvenance } from "./index";

let repo: FixtureRepo | undefined;
afterEach(() => {
  repo?.cleanup();
  repo = undefined;
});

async function provenanceOf(
  opts: Parameters<typeof createFixtureRepo>[0],
  structuralOnly = false,
) {
  repo = createFixtureRepo(opts);
  const ctx = await buildContext(repo.rootPath);
  return { result: analyzeProvenance(ctx, { structuralOnly }), ctx };
}

// ---------------------------------------------------------------------------
// Fixture generators
// ---------------------------------------------------------------------------

/** The same helper, structurally identical, with names and literals changed. */
function duplicatedHelper(name: string, sep: string): string {
  return `export const ${name} = (value) => {
  const parsed = new Date(value);
  const year = parsed.getFullYear();
  const month = parsed.getMonth() + 1;
  const day = parsed.getDate();
  return year + "${sep}" + month + "${sep}" + day;
};
`;
}

/**
 * Structurally distinct functions, so the clone detector should stay quiet.
 *
 * Each variant uses a different control-flow construct — a loop, a switch, a
 * reduce, a while with try/catch, a filter chain. Varying only identifiers and
 * literals would NOT be enough: type-2 clone detection erases exactly those, so
 * such a fixture would (correctly) register as 100% duplicated.
 */
function distinctModule(i: number): string {
  const bodies = [
    `  let acc = "";
  for (let n = 0; n < input.length; n++) {
    acc += input[n] === "x" ? "-" : input[n];
  }
  return acc;`,
    `  switch (input.length % 3) {
    case 0:
      return input.toUpperCase();
    case 1:
      return input.toLowerCase();
    default:
      return input.split("").reverse().join("");
  }`,
    `  return input.split("").reduce((carry, ch) => {
    return carry + String(ch.charCodeAt(0) % 7);
  }, "seed:");`,
    `  let remaining = input;
  let depth = 0;
  while (remaining.length > 2 && depth < 5) {
    try {
      remaining = remaining.slice(1, -1);
    } catch {
      break;
    }
    depth += 1;
  }
  return remaining + ":" + depth;`,
    `  const parts = input
    .split("")
    .filter((ch) => ch !== " ")
    .map((ch, idx) => idx + ch);
  if (parts.length === 0) {
    throw new Error("empty input");
  }
  return parts.join("|");`,
  ];

  const validators = [
    `  return input.length > ${i} && input.startsWith("a");`,
    `  if (!input) {
    return false;
  }
  for (const ch of input) {
    if (ch === "!") {
      return false;
    }
  }
  return true;`,
    `  const seen = new Set<string>();
  for (const ch of input) {
    if (seen.has(ch)) {
      return false;
    }
    seen.add(ch);
  }
  return seen.size > ${i % 3};`,
  ];

  return `// Callers depend on this ordering.
export const transform${i} = (input: string): string => {
${bodies[i % bodies.length]}
};

// Rejects payloads the upstream queue would retry forever.
export const validate${i} = (input: string): boolean => {
${validators[i % validators.length]}
};
`;
}

function vibeFiles(): Record<string, string> {
  const files: Record<string, string> = {
    "package.json": JSON.stringify({
      name: "vibe-app",
      dependencies: {
        next: "^15.0.0",
        react: "^19.0.0",
        zod: "^3.0.0",
        axios: "^1.0.0",
        lodash: "^4.0.0",
        moment: "^2.0.0",
        uuid: "^9.0.0",
        clsx: "^2.0.0",
        "date-fns": "^3.0.0",
        "framer-motion": "^11.0.0",
      },
    }),
    // Three grab-bag modules with a colliding export name.
    "src/utils.ts": duplicatedHelper("formatDate", "-"),
    "src/helpers.ts": duplicatedHelper("prettyDate", "/"),
    "src/lib.ts": `${duplicatedHelper("displayDate", ".")}export const formatDate = (v) => String(v);\n`,
    "src/common.ts": duplicatedHelper("renderDate", " "),
  };

  // Each file picks different conventions — the drift signal's target.
  for (let i = 0; i < 10; i++) {
    const useDefault = i % 2 === 0;
    const usePromiseChain = i % 3 === 0;
    const body = usePromiseChain
      ? `  return fetch('/api/item/${i}').then(r => r.json()).catch(e => null)`
      : `  try {\n    const r = await fetch("/api/item/${i}");\n    return await r.json();\n  } catch (e) {\n    return null;\n  }`;
    const signature = usePromiseChain
      ? `const loadItem${i} = () => {`
      : `const loadItem${i} = async () => {`;

    files[`src/features/item${i}.ts`] =
      `// load the item\n${signature}\n${body}\n}\n\n` +
      `// format the label\nconst formatLabel${i} = (label) => label.trim()\n\n` +
      (useDefault
        ? `export default { loadItem${i}, formatLabel${i} }\n`
        : `export { loadItem${i}, formatLabel${i} };\n`);
  }

  // Files nothing imports and no framework loads.
  for (let i = 0; i < 4; i++) {
    files[`src/unused/leftover${i}.ts`] = `export const leftover${i} = ${i};\n`;
  }

  files["src/app.test.ts"] = Array.from(
    { length: 6 },
    (_, i) => `it("works ${i}", () => {
  const mockFn = vi.fn();
  mockFn();
  expect(mockFn).toHaveBeenCalled();
});`,
  ).join("\n\n");

  return files;
}

function handWrittenFiles(): Record<string, string> {
  const files: Record<string, string> = {
    "package.json": JSON.stringify({
      name: "crafted-app",
      dependencies: {
        next: "^15.0.0",
        react: "^19.0.0",
        zod: "^3.0.0",
        clsx: "^2.0.0",
      },
      devDependencies: {
        typescript: "^5.0.0",
        vitest: "^2.0.0",
        eslint: "^9.0.0",
        prettier: "^3.0.0",
      },
    }),
    "tsconfig.json": `{"compilerOptions":{"baseUrl":".","paths":{"@/*":["src/*"]}}}`,
    "src/index.ts": "",
  };

  const moduleNames: string[] = [];
  for (let i = 0; i < 14; i++) {
    const name = `module${i}`;
    moduleNames.push(name);
    // distinctModule carries comments that explain intent rather than
    // restating the code beneath them.
    files[`src/${name}.ts`] = distinctModule(i);
  }

  // Every module is imported, so nothing reads as orphaned.
  files["src/index.ts"] = moduleNames
    .map((n, i) => `import { transform${i}, validate${i} } from "./${n}.js";`)
    .join("\n") +
    `\n\nexport const registry = {\n${moduleNames
      .map((_, i) => `  transform${i},\n  validate${i},`)
      .join("\n")}\n};\n`;

  files["src/registry.test.ts"] = Array.from(
    { length: 6 },
    (_, i) => `it("transform${i} joins its steps", () => {
  expect(transform${i}("abcdefgh")).toContain("|");
});`,
  ).join("\n\n");

  return files;
}

/** Three enormous commits on a single day with throwaway messages. */
function vibeCommits(): FixtureCommit[] {
  const files = vibeFiles();
  const entries = Object.entries(files);
  const third = Math.ceil(entries.length / 3);
  return [
    {
      message: "initial commit",
      files: Object.fromEntries(entries.slice(0, third)),
      date: "2025-03-01T10:00:00Z",
    },
    {
      message: "fix",
      files: Object.fromEntries(entries.slice(third, third * 2)),
      date: "2025-03-01T11:30:00Z",
    },
    {
      message: "fix",
      files: Object.fromEntries(entries.slice(third * 2)),
      date: "2025-03-01T12:15:00Z",
    },
    ...Array.from({ length: 4 }, (_, i) => ({
      message: i % 2 === 0 ? "wip" : "update",
      files: { [`src/features/item${i}.ts`]: files[`src/features/item${i}.ts`]! + `\n// tweak ${i}\n` },
      date: `2025-03-01T1${3 + i}:00:00Z`,
    })),
  ];
}

/** Many small commits, descriptive messages, spread across weeks. */
function handWrittenCommits(): FixtureCommit[] {
  const files = handWrittenFiles();
  const commits: FixtureCommit[] = [
    {
      message: "chore: set up project scaffolding and tsconfig",
      files: {
        "package.json": files["package.json"]!,
        "tsconfig.json": files["tsconfig.json"]!,
      },
      date: "2025-01-06T09:00:00Z",
    },
  ];

  for (let i = 0; i < 14; i++) {
    commits.push({
      message: `feat: add module${i} transform and validation rules`,
      files: { [`src/${`module${i}`}.ts`]: files[`src/module${i}.ts`]! },
      // One module every couple of days.
      date: new Date(
        Date.UTC(2025, 0, 8 + i * 2, 9 + (i % 6), 15),
      ).toISOString(),
    });
  }

  commits.push(
    {
      message: "feat: expose a registry of all transforms",
      files: { "src/index.ts": files["src/index.ts"]! },
      date: "2025-02-10T14:00:00Z",
    },
    {
      message: "test: cover transform output shape",
      files: { "src/registry.test.ts": files["src/registry.test.ts"]! },
      date: "2025-02-12T11:00:00Z",
    },
    {
      message: "refactor: tighten validate0 boundary handling",
      files: { "src/module0.ts": files["src/module0.ts"]! + "\n// revisited\n" },
      date: "2025-02-14T16:30:00Z",
    },
  );

  return commits;
}

// ---------------------------------------------------------------------------
// Calibration
// ---------------------------------------------------------------------------

describe("provenance calibration", () => {
  it("separates an agent-built repo from a hand-written one using structure alone", async () => {
    const vibe = await provenanceOf({ commits: vibeCommits() }, true);
    const vibeScore = vibe.result.score.score;
    repo!.cleanup();
    repo = undefined;

    const hand = await provenanceOf({ commits: handWrittenCommits() }, true);
    const handScore = hand.result.score.score;

    // Ground-truth signals are disabled, so this is the structural signals alone.
    expect(vibeScore).toBeGreaterThan(handScore + 25);
    expect(vibeScore).toBeGreaterThan(45);
    expect(handScore).toBeLessThan(35);
  });
});

describe("confidence handling", () => {
  it("reports certain confidence when commit trailers name an agent", async () => {
    const { result } = await provenanceOf({
      commits: [
        {
          message: "feat: scaffold\n\nCo-Authored-By: Claude <noreply@anthropic.com>",
          files: vibeFiles(),
        },
      ],
    });

    expect(result.agents).toContain("Claude Code");
    expect(result.score.confidence).toBe("certain");
    expect(result.findings.some((f) => f.ruleId === "ai-authored-commits")).toBe(true);
  });

  it("lowers confidence rather than the score when git history is absent", async () => {
    const files = vibeFiles();

    const withGit = await provenanceOf({ commits: vibeCommits() }, true);
    const gitScore = withGit.result.score.score;
    const gitConfidence = withGit.result.score.confidence;
    repo!.cleanup();
    repo = undefined;

    const withoutGit = await provenanceOf({ files, withoutGit: true }, true);
    const zipScore = withoutGit.result.score.score;

    // The same code must not look cleaner just because history is missing.
    expect(zipScore).toBeGreaterThan(40);
    expect(Math.abs(zipScore - gitScore)).toBeLessThan(25);

    expect(withoutGit.result.score.confidence).not.toBe("certain");
    expect(
      withoutGit.result.score.unavailable.join(" "),
    ).toMatch(/git history|commit/i);
    expect(gitConfidence).not.toBe("low");
  });
});

// ---------------------------------------------------------------------------
// Individual signals
// ---------------------------------------------------------------------------

describe("individual signals", () => {
  it("detects structurally identical functions across files", async () => {
    const { result } = await provenanceOf({ files: vibeFiles(), withoutGit: true });

    const clone = result.findings.find((f) => f.ruleId === "duplicate-function");
    expect(clone).toBeDefined();
    expect(clone!.locations.length).toBeGreaterThanOrEqual(4);
    // The four date helpers differ only in name and separator.
    expect(clone!.data["names"]).toEqual(
      expect.arrayContaining(["formatDate", "prettyDate", "displayDate"]),
    );
  });

  it("flags declared dependencies that are never imported", async () => {
    const { result } = await provenanceOf({ files: vibeFiles(), withoutGit: true });

    const unused = result.findings.find((f) => f.ruleId === "unused-dependencies");
    expect(unused).toBeDefined();
    expect(unused!.data["packages"]).toEqual(
      expect.arrayContaining(["axios", "lodash", "moment"]),
    );
  });

  it("identifies AI builder platforms from their artifacts", async () => {
    const { result } = await provenanceOf({
      files: {
        ...vibeFiles(),
        "package.json": JSON.stringify({
          name: "vite_react_shadcn_ts",
          dependencies: { react: "^19.0.0", "lovable-tagger": "^1.0.0" },
        }),
      },
      withoutGit: true,
    });

    const platform = result.findings.find((f) => f.ruleId === "ai-builder-platform");
    expect(platform).toBeDefined();
    expect(platform!.data["platforms"]).toContain("Lovable");
    expect(result.score.confidence).toBe("certain");
  });

  it("does not flag a clean repo as platform-generated", async () => {
    const { result } = await provenanceOf({
      files: handWrittenFiles(),
      withoutGit: true,
    });
    expect(result.findings.some((f) => f.ruleId === "ai-builder-platform")).toBe(
      false,
    );
  });
});

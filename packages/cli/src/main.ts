import { existsSync } from "node:fs";
import path from "node:path";
import { parseArgs } from "node:util";

import {
  probeStructuralParsers,
  scanGitHubRepository,
  scanRepository,
  type ScanStage,
} from "@vibe/engine";
import {
  PERSONAS,
  parseRepoSlug,
  toMermaid,
  type Persona,
  type ScanResult,
} from "@vibe/shared";

import { renderReport } from "./render/report";
import { renderSignals } from "./render/signals";
import { accent, bold, dim, setColor } from "./term";

/** Kept in step with the published manifest by the build, never read at runtime. */
export const VERSION = "0.1.0";

const USAGE = `
${bold("repo-audit")} — how much of a codebase looks AI-generated, with evidence.

${bold("USAGE")}
  repo-audit <path | owner/repo | github-url> [options]

${bold("EXAMPLES")}
  repo-audit .                          scan the current checkout
  repo-audit ../some-project            scan a local directory
  repo-audit sindresorhus/ky            scan a public GitHub repository
  repo-audit https://github.com/a/b     the same, pasted from the address bar
  repo-audit . --json > report.json     machine-readable output

${bold("OPTIONS")}
  --persona <name>     founder | engineer | acquirer   (default: founder)
  --signals            the signal-by-signal breakdown instead of the report
  --json               the raw scan result
  --mermaid            the module graph as Mermaid, for a README
  --offline            skip the dependency advisory lookup (the only network call)
  --structural-only    ignore commit trailers and agent config, as calibration does
  --token <token>      GitHub token; defaults to $GITHUB_TOKEN
  --no-color           plain text (also honours NO_COLOR)
  --selftest           report which parsers and grammars actually loaded
  --version            print the version
  --help               this

${bold("NOTES")}
  A local checkout is read at full strength. Scanning through GitHub gives
  per-commit totals but no per-file changes, so several history signals report
  themselves unavailable and confidence drops — the report says which.

  No code from the analysed repository is ever executed.
`;

export interface CliResult {
  stdout: string;
  stderr: string;
  exitCode: number;
}

/**
 * Parse arguments and run one scan.
 *
 * Returns rather than prints, so the whole surface is testable — the two dev
 * CLIs this replaces each called `main()` on import and exported nothing, which
 * is why neither had a single test.
 *
 * **Exit code is 0 unless the scan itself failed.** This tool never fails a
 * build: its own top risk is a false positive on someone's code, and a wrong
 * answer that blocks work costs far more than one that is merely read.
 */
export async function run(argv: string[]): Promise<CliResult> {
  let parsed;
  try {
    parsed = parseArgs({
      args: argv,
      allowPositionals: true,
      // Strict: an unknown flag is an error. Both CLIs this replaces ignored
      // them silently, which is the same shape as every "a parser that quietly
      // produces nothing looks like a clean result" bug in this project.
      strict: true,
      options: {
        persona: { type: "string" },
        signals: { type: "boolean", default: false },
        json: { type: "boolean", default: false },
        mermaid: { type: "boolean", default: false },
        offline: { type: "boolean", default: false },
        "structural-only": { type: "boolean", default: false },
        token: { type: "string" },
        color: { type: "boolean", default: true },
        selftest: { type: "boolean", default: false },
        version: { type: "boolean", default: false },
        help: { type: "boolean", default: false },
      },
    });
  } catch (err) {
    return {
      stdout: "",
      stderr: `${String(err instanceof Error ? err.message : err)}\n\nTry --help.\n`,
      exitCode: 2,
    };
  }

  const { values, positionals } = parsed;
  setColor(values.color !== false);

  if (values.help) return { stdout: USAGE, stderr: "", exitCode: 0 };
  if (values.version) return { stdout: `${VERSION}\n`, stderr: "", exitCode: 0 };
  if (values.selftest) return selftest();

  const persona = resolvePersona(values.persona);
  if (persona instanceof Error) {
    return { stdout: "", stderr: `${persona.message}\n`, exitCode: 2 };
  }

  const target = positionals[0];
  if (!target) {
    return {
      stdout: "",
      stderr: "Nothing to scan. Give a path, an owner/repo, or a GitHub URL.\n\n" + USAGE,
      exitCode: 2,
    };
  }
  if (positionals.length > 1) {
    return {
      stdout: "",
      stderr: `Expected one repository, got ${positionals.length}: ${positionals.join(", ")}\n`,
      exitCode: 2,
    };
  }

  /*
   * Progress goes to stderr, always — `repo-audit . --json > out.json` has to
   * produce a clean file, and a stage line written to stdout would corrupt it.
   */
  const quiet = values.json || values.mermaid;
  const onProgress = (stage: ScanStage) => {
    if (!quiet && process.stderr.isTTY) {
      process.stderr.write(`${dim("  · " + stage.label)}\n`);
    }
  };

  let result: ScanResult;
  try {
    result = await scan(target, {
      persona,
      offline: values.offline === true,
      structuralOnly: values["structural-only"] === true,
      ...(values.token ? { token: values.token } : {}),
      onProgress,
    });
  } catch (err) {
    return {
      stdout: "",
      stderr: `${formatScanError(err)}\n`,
      exitCode: 1,
    };
  }

  if (values.json) {
    return { stdout: JSON.stringify(result, null, 2) + "\n", stderr: "", exitCode: 0 };
  }

  if (values.mermaid) {
    if (!result.moduleGraph) {
      return {
        stdout: "",
        stderr:
          "No module graph for this repository — imports are resolved for " +
          "JavaScript and TypeScript only.\n",
        exitCode: 0,
      };
    }
    return { stdout: toMermaid(result.moduleGraph) + "\n", stderr: "", exitCode: 0 };
  }

  const body = values.signals
    ? renderSignals(result, persona)
    : renderReport(result, persona);
  return { stdout: body, stderr: "", exitCode: 0 };
}

interface ScanArgs {
  persona: Persona;
  offline: boolean;
  structuralOnly: boolean;
  token?: string;
  onProgress: (stage: ScanStage) => void;
}

/**
 * A local path always wins over a slug.
 *
 * A directory named like `owner/repo` would otherwise silently hit the network
 * instead of scanning what is on disk — and this is the tool's private-code
 * story, so guessing wrong in that direction would send a path to GitHub that
 * the user meant to keep local.
 */
async function scan(target: string, args: ScanArgs): Promise<ScanResult> {
  const structuralOnly = args.structuralOnly;
  // The dependency advisory lookup is the only analysis that leaves the
  // machine, so it is opt-out here and opt-in in the library.
  const checkVulnerabilities = !args.offline;

  if (existsSync(target)) {
    const rootPath = path.resolve(target);
    return scanRepository(rootPath, {
      kind: "zip",
      name: path.basename(rootPath),
      structuralOnly,
      checkVulnerabilities,
      onProgress: args.onProgress,
    });
  }

  const slug = parseRepoSlug(target);
  if (!slug) {
    throw new Error(
      `Not a directory, and not a repository I can parse: ${target}\n` +
        `Expected a path, "owner/repo", or a GitHub URL.`,
    );
  }

  const token = args.token ?? process.env["GITHUB_TOKEN"];
  return scanGitHubRepository(slug, {
    structuralOnly,
    checkVulnerabilities,
    onProgress: args.onProgress,
    ...(token ? { token } : {}),
  });
}

function resolvePersona(value: string | undefined): Persona | Error {
  if (value === undefined) return "founder";
  if ((PERSONAS as readonly string[]).includes(value)) return value as Persona;
  // Deliberately an error rather than a fallback. The old `report` CLI silently
  // used `founder` for any unrecognised value, so a typo produced a report for
  // the wrong reader with nothing said about it.
  return new Error(
    `Unknown persona "${value}". Expected one of: ${PERSONAS.join(", ")}.`,
  );
}

/** Which parsers and grammars actually loaded, for a bug report. */
async function selftest(): Promise<CliResult> {
  const probes = await probeStructuralParsers();
  const lines = [
    "",
    `  ${bold("repo-audit")} ${VERSION}`,
    `  node ${process.versions.node} on ${process.platform}-${process.arch}`,
    "",
    `  ${bold("Structural grammars")}`,
  ];

  for (const probe of probes) {
    lines.push(
      probe.ok
        ? `    ${probe.language.padEnd(8)} ${accent("ok")}`
        : `    ${probe.language.padEnd(8)} FAILED — ${probe.reason ?? "unknown"}`,
    );
  }

  const failed = probes.filter((p) => !p.ok);
  lines.push("");
  if (failed.length > 0) {
    lines.push(
      "  Those languages will fall back to commit-history analysis only.",
    );
    lines.push("");
  }

  /*
   * Still exit 0. A degraded install is worth reporting and is not a crash,
   * and the scan output already names the affected languages in its warnings
   * for the languages a given repository actually contains.
   */
  return { stdout: lines.join("\n") + "\n", stderr: "", exitCode: 0 };
}

/** GitHub's errors carry a status worth surfacing; everything else is a message. */
function formatScanError(err: unknown): string {
  if (err instanceof Error) {
    const status = (err as { status?: number }).status;
    if (status === 403) return `${err.message}`;
    if (status === 404) {
      return `${err.message}\nCheck the spelling, or whether the repository is private.`;
    }
    if (status === 429) {
      return (
        `${err.message}\nGitHub's unauthenticated limit is 60 requests an hour. ` +
        `Set GITHUB_TOKEN or pass --token to raise it.`
      );
    }
    return err.message;
  }
  return String(err);
}

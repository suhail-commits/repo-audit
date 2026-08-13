import { basenameOf, isRequirementsFile } from "../../ingest/guards";
import type { AnalysisContext } from "../context";

/**
 * Installed package versions, read out of lockfiles and manifests.
 *
 * **Hand-written, no new dependency.** Every format here is regular enough to
 * read line by line: `pnpm-lock.yaml`'s `packages:` block is a flat list of
 * `'name@version':` keys, `package-lock.json` and `poetry.lock`-adjacent files
 * are structured text, `yarn.lock` is a simple block format. Pulling in a YAML
 * parser to read four flat lists would be the kind of convenience dependency
 * this project counts as a cost — in a tool that flags dependency bloat.
 *
 * The whole transitive tree is collected, not just direct dependencies. That
 * finds genuinely more, and it is why `directFor()` exists: reporting 40
 * vulnerabilities the reader did not choose and cannot fix is how `npm audit`
 * earned its reputation, so every transitive package is attributed back to the
 * direct dependency that pulled it in.
 */

export type Ecosystem = "npm" | "PyPI" | "Go" | "crates.io";

export interface InstalledPackage {
  ecosystem: Ecosystem;
  name: string;
  version: string;
  /** Manifest this came from, for the report. */
  source: string;
  /** True when the repository's own manifest lists it directly. */
  direct: boolean;
  /** Direct dependency it was pulled in through, when it is not itself direct. */
  via?: string;
  /** True when the only path to it is through a dev-time tool. */
  devOnly: boolean;
}

export function collectPackages(ctx: AnalysisContext): InstalledPackage[] {
  const out: InstalledPackage[] = [];

  for (const file of ctx.files.all()) {
    // `requirements.txt` has no single name — `requirements-dev.txt` and
    // `requirements/base.txt` are both conventional — so it is matched by
    // pattern before the exact-name switch.
    if (isRequirementsFile(file.relPath)) {
      out.push(...fromRequirements(file.content, file.relPath));
      continue;
    }

    switch (basenameOf(file.relPath)) {
      case "package-lock.json":
        out.push(...fromNpmLock(file.content, file.relPath, ctx));
        break;
      case "pnpm-lock.yaml":
        out.push(...fromPnpmLock(file.content, file.relPath, ctx));
        break;
      case "yarn.lock":
        out.push(...fromYarnLock(file.content, file.relPath, ctx));
        break;
      case "poetry.lock":
        out.push(...fromPoetryLock(file.content, file.relPath));
        break;
      case "go.mod":
        out.push(...fromGoMod(file.content, file.relPath));
        break;
      case "cargo.lock":
        out.push(...fromCargoLock(file.content, file.relPath));
        break;
      default:
        break;
    }
  }

  return dedupe(out);
}

/** The same package can appear in several manifests; query it once. */
function dedupe(packages: InstalledPackage[]): InstalledPackage[] {
  const byKey = new Map<string, InstalledPackage>();
  for (const pkg of packages) {
    const key = `${pkg.ecosystem} ${pkg.name} ${pkg.version}`;
    const existing = byKey.get(key);
    // A package reachable both directly and transitively is direct; one
    // reachable from runtime and dev code is a runtime dependency.
    if (!existing) byKey.set(key, pkg);
    else {
      byKey.set(key, {
        ...existing,
        direct: existing.direct || pkg.direct,
        devOnly: existing.devOnly && pkg.devOnly,
      });
    }
  }
  return [...byKey.values()];
}

// ---------------------------------------------------------------------------
// npm
// ---------------------------------------------------------------------------

/**
 * Split `@scope/name@1.2.3` into its parts.
 *
 * The leading `@` of a scope is why this cannot be a `split("@")`: the scope
 * separator and the version separator are the same character.
 */
export function splitNpmSpec(spec: string): { name: string; version: string } | null {
  /*
   * The peer suffix is stripped *first*, and the order matters. pnpm writes
   * `next@16.3.0(react@19.2.8)`, so searching the raw string for the last `@`
   * lands inside the parentheses and yields the package name
   * `next@16.3.0(react` — a name OSV will never match, for most entries in a
   * real lockfile, with nothing to show that anything went wrong.
   */
  const cleaned = spec.replace(/\(.*$/, "");
  const at = cleaned.lastIndexOf("@");
  if (at <= 0) return null;

  const version = cleaned.slice(at + 1);
  // `workspace:*`, `link:../x` and friends have no version to look up.
  if (!/^\d/.test(version)) return null;

  return { name: cleaned.slice(0, at), version };
}

function npmDirect(ctx: AnalysisContext): {
  runtime: Set<string>;
  all: Set<string>;
} {
  return {
    runtime: new Set(Object.keys(ctx.frameworks.runtimeDependencies)),
    all: new Set(Object.keys(ctx.frameworks.dependencies)),
  };
}

function fromNpmLock(
  content: string,
  source: string,
  ctx: AnalysisContext,
): InstalledPackage[] {
  let parsed: {
    packages?: Record<string, { version?: string; dev?: boolean }>;
    dependencies?: Record<string, { version?: string; dev?: boolean }>;
  };
  try {
    parsed = JSON.parse(content);
  } catch {
    return [];
  }

  const { runtime, all } = npmDirect(ctx);
  const out: InstalledPackage[] = [];

  // Lockfile v2/v3: keys are install paths like "node_modules/left-pad".
  for (const [key, entry] of Object.entries(parsed.packages ?? {})) {
    if (key === "" || !entry?.version) continue;
    const name = key.slice(key.lastIndexOf("node_modules/") + "node_modules/".length);
    if (!name) continue;
    out.push({
      ecosystem: "npm",
      name,
      version: entry.version,
      source,
      direct: all.has(name),
      devOnly: entry.dev === true || (all.has(name) && !runtime.has(name)),
    });
  }

  // Lockfile v1 has no `packages` map.
  for (const [name, entry] of Object.entries(parsed.dependencies ?? {})) {
    if (!entry?.version) continue;
    out.push({
      ecosystem: "npm",
      name,
      version: entry.version,
      source,
      direct: all.has(name),
      devOnly: entry.dev === true || (all.has(name) && !runtime.has(name)),
    });
  }

  return out;
}

/**
 * `pnpm-lock.yaml`'s `packages:` block.
 *
 * Every entry is two-space indented and of the form `'name@version':`. What
 * ships versus what is only built with comes from `pnpmReachability` below,
 * which walks the `snapshots:` edges — not from whether the name appears in a
 * `package.json`, which is true of no transitive package at all.
 */
function fromPnpmLock(
  content: string,
  source: string,
  ctx: AnalysisContext,
): InstalledPackage[] {
  const { runtime, all } = npmDirect(ctx);
  const reach = pnpmReachability(content);
  const out: InstalledPackage[] = [];

  let inPackages = false;
  for (const line of content.split(/\r\n|\r|\n/)) {
    if (/^[a-zA-Z]/.test(line)) {
      inPackages = line.startsWith("packages:");
      continue;
    }
    if (!inPackages) continue;

    const match = /^ {2}(?! )'?([^']+?)'?:\s*$/.exec(line);
    if (!match) continue;

    const spec = splitNpmSpec(match[1]!);
    if (!spec) continue;

    const key = `${spec.name}@${spec.version}`;
    const reached = reach.get(key);

    out.push({
      ecosystem: "npm",
      name: spec.name,
      version: spec.version,
      source,
      direct: all.has(spec.name),
      /*
       * Decided by reachability first, because a transitive package appears in
       * no manifest at all — testing membership marked every one of them as
       * shipping code, and reported `esbuild` and `vite`, which reach this
       * repository only through `vitest`, as production dependencies.
       *
       * The manifest is the fallback for a lockfile with no `importers:`
       * block, where there are no roots to walk from. That still knows a
       * directly-declared devDependency is dev; only genuine transitives
       * default to shipped, which is the safe direction for a security check.
       */
      devOnly: reached
        ? reached.devOnly
        : all.has(spec.name) && !runtime.has(spec.name),
      ...(reached?.via ? { via: reached.via } : {}),
    });
  }

  return out;
}

interface Reach {
  devOnly: boolean;
  /** Direct dependency this was pulled in through. */
  via?: string;
}

/**
 * Walk pnpm's dependency graph to find what actually ships.
 *
 * `importers:` names each workspace's direct dependencies, split into runtime
 * and dev. `snapshots:` carries the edges between resolved packages. A
 * breadth-first walk from the runtime roots marks everything reachable from
 * shipped code; whatever is left is reachable only from tooling.
 *
 * This is what makes checking the whole transitive tree bearable to read. The
 * alternative — reporting every advisory in the tree at equal weight — is the
 * thing that made `npm audit` something people stopped looking at.
 */
export function pnpmReachability(content: string): Map<string, Reach> {
  const lines = content.split(/\r\n|\r|\n/);

  const runtimeRoots = new Map<string, string>();
  const devRoots = new Map<string, string>();
  const edges = new Map<string, string[]>();

  let section: "importers" | "snapshots" | "other" = "other";
  let inDev = false;
  let currentSnapshot: string | null = null;
  let inSnapshotDeps = false;
  let pendingName: string | null = null;

  for (const line of lines) {
    if (/^[a-zA-Z]/.test(line)) {
      section = line.startsWith("importers:")
        ? "importers"
        : line.startsWith("snapshots:")
          ? "snapshots"
          : "other";
      currentSnapshot = null;
      pendingName = null;
      continue;
    }

    if (section === "importers") {
      const group = /^ {4}(dependencies|devDependencies|optionalDependencies):\s*$/.exec(line);
      if (group) {
        inDev = group[1] === "devDependencies";
        continue;
      }
      const name = /^ {6}(?! )'?([^':]+?)'?:\s*$/.exec(line);
      if (name) {
        pendingName = name[1]!;
        continue;
      }
      const version = /^ {8}version:\s*(.+)$/.exec(line);
      if (version && pendingName) {
        const resolved = version[1]!.trim().replace(/\(.*$/, "");
        // Workspace links resolve to a path, not a version, and are ours.
        if (/^\d/.test(resolved)) {
          (inDev ? devRoots : runtimeRoots).set(
            `${pendingName}@${resolved}`,
            pendingName,
          );
        }
        pendingName = null;
      }
      continue;
    }

    if (section === "snapshots") {
      const head = /^ {2}(?! )'?([^']+?)'?:\s*$/.exec(line);
      if (head) {
        const spec = splitNpmSpec(head[1]!);
        currentSnapshot = spec ? `${spec.name}@${spec.version}` : null;
        inSnapshotDeps = false;
        continue;
      }
      if (/^ {4}(dependencies|optionalDependencies):\s*$/.test(line)) {
        inSnapshotDeps = true;
        continue;
      }
      if (/^ {4}\w/.test(line)) {
        inSnapshotDeps = false;
        continue;
      }
      const edge = /^ {6}(?! )'?([^':]+?)'?:\s*(.+)$/.exec(line);
      if (edge && inSnapshotDeps && currentSnapshot) {
        const target = `${edge[1]!}@${edge[2]!.trim().replace(/\(.*$/, "")}`;
        edges.set(currentSnapshot, [...(edges.get(currentSnapshot) ?? []), target]);
      }
    }
  }

  const reach = new Map<string, Reach>();

  const walk = (roots: Map<string, string>, devOnly: boolean) => {
    const queue = [...roots.entries()].map(([spec, via]) => ({ spec, via }));
    const seen = new Set<string>();

    while (queue.length > 0) {
      const { spec, via } = queue.shift()!;
      if (seen.has(spec)) continue;
      seen.add(spec);

      const existing = reach.get(spec);
      // Reachable from both shipped and dev code means it ships.
      if (!existing || (existing.devOnly && !devOnly)) {
        reach.set(spec, { devOnly, ...(via ? { via } : {}) });
      }

      for (const next of edges.get(spec) ?? []) {
        if (!seen.has(next)) queue.push({ spec: next, via });
      }
    }
  };

  // Runtime first, so a package reachable both ways is already marked shipped
  // before the dev walk considers it.
  walk(runtimeRoots, false);
  walk(devRoots, true);

  return reach;
}

/** `yarn.lock`: a `"name@range":` header, then an indented `version "x.y.z"`. */
function fromYarnLock(
  content: string,
  source: string,
  ctx: AnalysisContext,
): InstalledPackage[] {
  const { runtime, all } = npmDirect(ctx);
  const out: InstalledPackage[] = [];

  let pending: string | null = null;
  for (const line of content.split(/\r\n|\r|\n/)) {
    if (line.trim() === "" || line.startsWith("#")) continue;

    if (!line.startsWith(" ")) {
      // `"a@^1", "a@^2":` — every alias resolves to the same version below.
      const first = line.split(",")[0]!.replace(/:$/, "").trim().replace(/^"|"$/g, "");
      const at = first.lastIndexOf("@");
      pending = at > 0 ? first.slice(0, at) : null;
      continue;
    }

    const version = /^\s+version:?\s+"?([^"\s]+)"?/.exec(line);
    if (version && pending) {
      out.push({
        ecosystem: "npm",
        name: pending,
        version: version[1]!,
        source,
        direct: all.has(pending),
        devOnly: all.has(pending) && !runtime.has(pending),
      });
      pending = null;
    }
  }

  return out;
}

// ---------------------------------------------------------------------------
// PyPI, Go, crates.io
// ---------------------------------------------------------------------------

/** Only pinned requirements can be checked; a range has no single version. */
function fromRequirements(content: string, source: string): InstalledPackage[] {
  const out: InstalledPackage[] = [];

  for (const raw of content.split(/\r\n|\r|\n/)) {
    const line = raw.split("#")[0]!.trim();
    if (line === "" || line.startsWith("-")) continue;

    const match = /^([A-Za-z0-9._-]+)\s*==\s*([A-Za-z0-9._-]+)/.exec(line);
    if (!match) continue;

    out.push({
      ecosystem: "PyPI",
      name: match[1]!,
      version: match[2]!,
      source,
      direct: true,
      devOnly: /dev|test/i.test(source),
    });
  }

  return out;
}

/** `poetry.lock` is TOML: repeated `[[package]]` blocks with name and version. */
function fromPoetryLock(content: string, source: string): InstalledPackage[] {
  const out: InstalledPackage[] = [];
  let name: string | null = null;
  let category: string | null = null;

  const flush = (version: string) => {
    if (!name) return;
    out.push({
      ecosystem: "PyPI",
      name,
      version,
      source,
      direct: false,
      devOnly: category === "dev",
    });
    name = null;
    category = null;
  };

  for (const raw of content.split(/\r\n|\r|\n/)) {
    const line = raw.trim();
    if (line === "[[package]]") {
      name = null;
      category = null;
      continue;
    }
    const nameMatch = /^name\s*=\s*"([^"]+)"/.exec(line);
    if (nameMatch) {
      name = nameMatch[1]!;
      continue;
    }
    const categoryMatch = /^category\s*=\s*"([^"]+)"/.exec(line);
    if (categoryMatch) {
      category = categoryMatch[1]!;
      continue;
    }
    const versionMatch = /^version\s*=\s*"([^"]+)"/.exec(line);
    if (versionMatch) flush(versionMatch[1]!);
  }

  return out;
}

/** `go.mod`: `require` lines, single or block form. `// indirect` marks transitive. */
function fromGoMod(content: string, source: string): InstalledPackage[] {
  const out: InstalledPackage[] = [];
  let inBlock = false;

  for (const raw of content.split(/\r\n|\r|\n/)) {
    const line = raw.trim();

    if (/^require\s*\($/.test(line)) {
      inBlock = true;
      continue;
    }
    if (inBlock && line === ")") {
      inBlock = false;
      continue;
    }

    const body = inBlock ? line : /^require\s+(.+)$/.exec(line)?.[1];
    if (!body) continue;

    const match = /^([^\s]+)\s+(v[^\s]+)/.exec(body);
    if (!match) continue;

    out.push({
      ecosystem: "Go",
      name: match[1]!,
      version: match[2]!,
      source,
      direct: !/\/\/\s*indirect/.test(raw),
      devOnly: false,
    });
  }

  return out;
}

/** `Cargo.lock` is TOML: `[[package]]` blocks with name and version. */
function fromCargoLock(content: string, source: string): InstalledPackage[] {
  const out: InstalledPackage[] = [];
  let name: string | null = null;

  for (const raw of content.split(/\r\n|\r|\n/)) {
    const line = raw.trim();
    if (line === "[[package]]") {
      name = null;
      continue;
    }
    const nameMatch = /^name\s*=\s*"([^"]+)"/.exec(line);
    if (nameMatch) {
      name = nameMatch[1]!;
      continue;
    }
    const versionMatch = /^version\s*=\s*"([^"]+)"/.exec(line);
    if (versionMatch && name) {
      out.push({
        ecosystem: "crates.io",
        name,
        version: versionMatch[1]!,
        source,
        direct: false,
        devOnly: false,
      });
      name = null;
    }
  }

  return out;
}

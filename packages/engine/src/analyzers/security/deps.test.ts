import { afterEach, describe, expect, it } from "vitest";

import { buildContext } from "../../scan";
import { createFixtureRepo, type FixtureRepo } from "../../testing/fixture-repo";
import {
  analyzeDependencies,
  vulnerableDependencyFindings,
  vulnerableDependencySignal,
} from "./deps";
import { collectPackages, pnpmReachability, splitNpmSpec } from "./lockfiles";

let repo: FixtureRepo | undefined;
afterEach(() => {
  repo?.cleanup();
  repo = undefined;
});

async function contextFor(files: Record<string, string>) {
  repo = createFixtureRepo({ files, withoutGit: true });
  return buildContext(repo.rootPath);
}

/**
 * A fetch that never leaves the process.
 *
 * The whole suite must stay hermetic — a test that quietly reached OSV would
 * be slow, flaky, and would fail on a machine with no network for reasons that
 * have nothing to do with the code.
 */
function stubOsv(
  vulnerable: Record<string, string[]>,
  details: Record<string, { summary: string; severity: string }> = {},
): typeof fetch {
  return (async (input: string | URL | Request) => {
    const url = String(input);

    if (url.endsWith("/querybatch")) {
      return {
        ok: true,
        status: 200,
        json: async () => ({ results: [] }),
      } as unknown as Response;
    }

    const id = url.slice(url.lastIndexOf("/") + 1);
    const detail = details[id];
    return {
      ok: true,
      status: 200,
      json: async () => ({
        summary: detail?.summary,
        database_specific: { severity: detail?.severity },
      }),
    } as unknown as Response;
  }) as unknown as typeof fetch;
}

/** Batch responder that echoes advisories positionally, as OSV guarantees. */
function stubBatch(
  advisoriesFor: (name: string) => string[],
  details: Record<string, { summary: string; severity: string }> = {},
): typeof fetch {
  return (async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);

    if (url.endsWith("/querybatch")) {
      const body = JSON.parse(String(init?.body)) as {
        queries: { package: { name: string } }[];
      };
      return {
        ok: true,
        status: 200,
        json: async () => ({
          results: body.queries.map((q) => ({
            vulns: advisoriesFor(q.package.name).map((id) => ({ id })),
          })),
        }),
      } as unknown as Response;
    }

    const id = url.slice(url.lastIndexOf("/") + 1);
    const detail = details[id];
    return {
      ok: true,
      status: 200,
      json: async () => ({
        summary: detail?.summary,
        database_specific: { severity: detail?.severity },
      }),
    } as unknown as Response;
  }) as unknown as typeof fetch;
}

describe("lockfile reading", () => {
  it("splits scoped npm specs and strips pnpm peer suffixes", () => {
    expect(splitNpmSpec("left-pad@1.3.0")).toEqual({
      name: "left-pad",
      version: "1.3.0",
    });
    expect(splitNpmSpec("@scope/thing@2.1.4")).toEqual({
      name: "@scope/thing",
      version: "2.1.4",
    });
    expect(splitNpmSpec("next@16.3.0(react@19.2.8)")).toEqual({
      name: "next",
      version: "16.3.0",
    });
    // A workspace link has no version to check.
    expect(splitNpmSpec("@vibe/engine@workspace:*")).toBeNull();
  });

  it("reads a pnpm lockfile and marks direct runtime dependencies", async () => {
    const ctx = await contextFor({
      "package.json": JSON.stringify({
        name: "demo",
        dependencies: { express: "^4.18.0" },
        devDependencies: { vitest: "^2.1.0" },
      }),
      "pnpm-lock.yaml": [
        "lockfileVersion: '9.0'",
        "",
        "packages:",
        "",
        "  express@4.18.2:",
        "    resolution: {integrity: sha512-abc==}",
        "",
        "  vitest@2.1.9:",
        "    resolution: {integrity: sha512-def==}",
        "",
        "  '@scope/util@1.0.0':",
        "    resolution: {integrity: sha512-ghi==}",
        "",
      ].join("\n"),
      "src/index.ts": "export const x = 1;\n",
    });

    const packages = collectPackages(ctx);
    const byName = Object.fromEntries(packages.map((p) => [p.name, p]));

    expect(byName["express"]).toMatchObject({ version: "4.18.2", devOnly: false });
    expect(byName["vitest"]).toMatchObject({ version: "2.1.9", devOnly: true });
    expect(byName["@scope/util"]).toMatchObject({ version: "1.0.0" });
  });

  /**
   * The transitive walk, which is what stops this from reading like
   * `npm audit`.
   *
   * Regression test for a silent failure: the snapshot-key pattern was
   * `/^ {2}…/`, which matches *at least* two leading spaces — so the
   * four-space `dependencies:` line matched it too, was treated as a package
   * key, and `continue`d. No edge was ever recorded, the walk reached only the
   * direct dependencies, and every transitive package fell through to the
   * `devOnly: false` default. On this repository that reported `esbuild` and
   * `vite` — which arrive only through `vitest` — as shipped production
   * dependencies. Nothing threw and no assertion failed.
   */
  it("walks the snapshot graph to separate shipped code from tooling", () => {
    const lock = [
      "lockfileVersion: '9.0'",
      "",
      "importers:",
      "",
      "  .:",
      "    dependencies:",
      "      express:",
      "        specifier: ^4.18.0",
      "        version: 4.18.2",
      "    devDependencies:",
      "      vitest:",
      "        specifier: ^2.1.8",
      "        version: 2.1.9(@types/node@24.13.3)",
      "",
      "packages:",
      "",
      "  express@4.18.2:",
      "    resolution: {integrity: sha512-a==}",
      "",
      "  vitest@2.1.9:",
      "    resolution: {integrity: sha512-b==}",
      "",
      "  vite@5.4.21:",
      "    resolution: {integrity: sha512-c==}",
      "",
      "  esbuild@0.21.5:",
      "    resolution: {integrity: sha512-d==}",
      "",
      "snapshots:",
      "",
      "  express@4.18.2: {}",
      "",
      "  vitest@2.1.9(@types/node@24.13.3):",
      "    dependencies:",
      "      vite: 5.4.21(@types/node@24.13.3)",
      "    optionalDependencies:",
      "      '@types/node': 24.13.3",
      "",
      "  vite@5.4.21(@types/node@24.13.3):",
      "    dependencies:",
      "      esbuild: 0.21.5",
      "",
      "  esbuild@0.21.5: {}",
      "",
    ].join("\n");

    const reach = pnpmReachability(lock);

    expect(reach.get("express@4.18.2")).toEqual({
      devOnly: false,
      via: "express",
    });
    // Two hops from a devDependency, named in no package.json anywhere.
    expect(reach.get("vite@5.4.21")).toEqual({ devOnly: true, via: "vitest" });
    expect(reach.get("esbuild@0.21.5")).toEqual({
      devOnly: true,
      via: "vitest",
    });
  });

  it("reads pinned Python requirements and ignores ranges", async () => {
    const ctx = await contextFor({
      "requirements.txt": [
        "# comment",
        "requests==2.28.1",
        "urllib3>=1.26",
        "flask==2.2.2  # inline",
        "-r other.txt",
      ].join("\n"),
      "main.py": "x = 1\n",
    });

    const packages = collectPackages(ctx);
    expect(packages.map((p) => `${p.name}@${p.version}`).sort()).toEqual([
      "flask@2.2.2",
      "requests@2.28.1",
    ]);
    expect(packages[0]!.ecosystem).toBe("PyPI");
  });

  it("reads go.mod, distinguishing indirect requirements", async () => {
    const ctx = await contextFor({
      "go.mod": [
        "module example.com/demo",
        "",
        "go 1.21",
        "",
        "require (",
        "\tgithub.com/spf13/cobra v1.8.0",
        "\tgithub.com/inconshreveable/mousetrap v1.1.0 // indirect",
        ")",
      ].join("\n"),
      "main.go": "package main\n\nfunc main() {}\n",
    });

    const packages = collectPackages(ctx);
    expect(packages).toHaveLength(2);
    expect(packages.find((p) => p.name.includes("cobra"))!.direct).toBe(true);
    expect(packages.find((p) => p.name.includes("mousetrap"))!.direct).toBe(false);
  });

  it("reads Cargo.lock", async () => {
    const ctx = await contextFor({
      "Cargo.lock": [
        "[[package]]",
        'name = "regex"',
        'version = "1.10.2"',
        "",
        "[[package]]",
        'name = "serde"',
        'version = "1.0.193"',
      ].join("\n"),
      "src/main.rs": "fn main() {}\n",
    });

    const packages = collectPackages(ctx);
    expect(packages.map((p) => p.name).sort()).toEqual(["regex", "serde"]);
    expect(packages[0]!.ecosystem).toBe("crates.io");
  });
});

describe("vulnerability lookup", () => {
  const manifest = {
    "package.json": JSON.stringify({
      name: "demo",
      dependencies: { express: "^4.0.0" },
      devDependencies: { vitest: "^2.0.0" },
    }),
    "pnpm-lock.yaml": [
      "lockfileVersion: '9.0'",
      "",
      "packages:",
      "",
      "  express@4.17.1:",
      "    resolution: {integrity: sha512-a==}",
      "",
      "  vitest@2.0.0:",
      "    resolution: {integrity: sha512-b==}",
      "",
    ].join("\n"),
    "src/index.ts": "export const x = 1;\n",
  };

  it("reports a shipped dependency separately from a dev one", async () => {
    const ctx = await contextFor(manifest);

    const report = await analyzeDependencies(ctx, {
      osv: {
        fetchImpl: stubBatch(
          (name) => (name === "express" ? ["GHSA-aaaa"] : ["GHSA-bbbb"]),
          {
            "GHSA-aaaa": { summary: "Path traversal", severity: "HIGH" },
            "GHSA-bbbb": { summary: "ReDoS in test runner", severity: "LOW" },
          },
        ),
      },
    });

    expect(report.vulnerable).toHaveLength(2);
    expect(report.runtime.map((v) => v.pkg.name)).toEqual(["express"]);

    const findings = vulnerableDependencyFindings(report);
    const shipped = findings.find((f) => f.ruleId === "vulnerable-dependency")!;
    const dev = findings.find((f) => f.ruleId === "vulnerable-dev-dependency")!;

    expect(shipped.severity).toBe("high");
    expect(shipped.source).toBe("osv");
    // Build tooling is not attacker-reachable in production.
    expect(dev.severity).toBe("low");
  });

  it("stays quiet when nothing matches", async () => {
    const ctx = await contextFor(manifest);
    const report = await analyzeDependencies(ctx, {
      osv: { fetchImpl: stubBatch(() => []) },
    });

    expect(report.vulnerable).toHaveLength(0);
    expect(vulnerableDependencyFindings(report)).toHaveLength(0);

    const signal = vulnerableDependencySignal(report);
    expect(signal.available).toBe(true);
    expect(signal.value).toBe(0);
    expect(signal.evidence.join(" ")).toContain("none affected");
  });

  /**
   * A network failure is not a clean bill of health. It has to lower
   * confidence and leave the score alone — the same treatment every other
   * missing input gets.
   */
  it("reports unavailable when the database cannot be reached", async () => {
    const ctx = await contextFor(manifest);
    const report = await analyzeDependencies(ctx, {
      osv: {
        fetchImpl: (async () => {
          throw new Error("ENOTFOUND api.osv.dev");
        }) as unknown as typeof fetch,
      },
    });

    const signal = vulnerableDependencySignal(report);
    expect(signal.available).toBe(false);
    expect(signal.value).toBe(0);
    expect(signal.unavailableReason).toContain("could not reach");
    expect(vulnerableDependencyFindings(report)).toHaveLength(0);
  });

  it("reports unavailable when the lookup is switched off", async () => {
    const ctx = await contextFor(manifest);
    const report = await analyzeDependencies(ctx, { osv: { offline: true } });

    expect(vulnerableDependencySignal(report).available).toBe(false);
  });

  it("reports unavailable when there is no manifest to read", async () => {
    const ctx = await contextFor({ "src/index.ts": "export const x = 1;\n" });
    const report = await analyzeDependencies(ctx, {
      osv: { fetchImpl: stubOsv({}) },
    });

    const signal = vulnerableDependencySignal(report);
    expect(signal.available).toBe(false);
    expect(signal.unavailableReason).toContain("no lockfile");
  });
});

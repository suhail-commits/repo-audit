import { afterEach, describe, expect, it } from "vitest";

import { buildContext } from "../../scan";
import { createFixtureRepo, type FixtureRepo } from "../../testing/fixture-repo";
import { analyzeSecurity } from "./index";

let repo: FixtureRepo | undefined;
afterEach(() => {
  repo?.cleanup();
  repo = undefined;
});

async function securityOf(files: Record<string, string>) {
  repo = createFixtureRepo({ files, withoutGit: true });
  const ctx = await buildContext(repo.rootPath);
  return analyzeSecurity(ctx);
}

const signal = (result: Awaited<ReturnType<typeof securityOf>>, id: string) =>
  result.score.signals.find((s) => s.id === id)!;

/**
 * Correctly-shaped credentials that were never real.
 *
 * The bodies are the right length and character class for each vendor, because
 * a pattern that only matches a shorter placeholder proves nothing about
 * whether it would match the thing it exists to find.
 */
/**
 * The opening of the MIT text, which is what the fingerprint matches on.
 *
 * Fixtures that mean "nothing to find here" need one: a repository with no
 * licence genuinely does have something to find, so leaving it out would make
 * the silent cases assert silence about a repo that is not actually clean.
 */
const MIT =
  "MIT License\n\nCopyright (c) 2026 Example\n\n" +
  "Permission is hereby granted, free of charge, to any person obtaining a copy\n" +
  "of this software and associated documentation files (the \"Software\"), to deal\n" +
  "in the Software without restriction.\n";

const FAKE = {
  aws: "AKIA" + "QRSTUVWX2345YZ67",
  githubPat: "ghp_" + "aB3dE6gH9jK2mN5pQ8sT1vW4xY7zC0eF3iL6",
  stripe: "sk_live_" + "51HxKmQrStUvWxYz0123",
  anthropic: "sk-ant-" + "api03-QrStUvWxYz0123456789",
  slack: "xoxb-" + "2417283910-abcdefGHIJKL",
  google: "AIza" + "SyC1dE3gH5jK7mN9pQ2sT4vW6xY8zA0bC1d",
};

describe("hardcoded secrets", () => {
  it("finds a committed AWS key and reports it as certain", async () => {
    const result = await securityOf({
      "src/config.ts": `export const region = "us-east-1";\nexport const accessKeyId = "${FAKE.aws}";\n`,
    });

    expect(signal(result, "hardcoded-secrets").value).toBe(1);

    const finding = result.findings.find((f) => f.ruleId === "hardcoded-secret");
    expect(finding).toBeDefined();
    expect(finding!.data.vendor).toBe("aws-access-key");
    expect(finding!.severity).toBe("critical");
    expect(finding!.confidence).toBe("certain");
    expect(finding!.locations[0]).toMatchObject({
      file: "src/config.ts",
      line: 2,
    });
  });

  it("never prints the credential it found", async () => {
    const result = await securityOf({
      "src/config.ts": `export const key = "${FAKE.githubPat}";\n`,
    });

    const printed = JSON.stringify(result);
    expect(printed).not.toContain(FAKE.githubPat);
    // The kind of credential is still named — that is the actionable part.
    expect(printed).toContain("GitHub personal access token");
  });

  it("recognises each vendor prefix", async () => {
    for (const [vendor, value] of Object.entries(FAKE)) {
      const result = await securityOf({
        "src/a.ts": `export const token = "${value}";\n`,
      });
      expect(
        signal(result, "hardcoded-secrets").value,
        `${vendor} was not detected`,
      ).toBeGreaterThan(0);
      repo?.cleanup();
      repo = undefined;
    }
  });

  it("finds a private key block", async () => {
    const result = await securityOf({
      "deploy/id_rsa": "-----BEGIN RSA PRIVATE KEY-----\nMIIEow==\n-----END RSA PRIVATE KEY-----\n",
      "src/a.ts": "export const x = 1;\n",
    });

    expect(
      result.findings.some((f) => f.data.vendor === "private-key"),
    ).toBe(true);
  });

  // ---- the silent cases, which are the ones that matter --------------------

  it("stays silent on a repository with no credentials", async () => {
    const result = await securityOf({
      LICENSE: MIT,
      "src/index.ts": "export function add(a: number, b: number) {\n  return a + b;\n}\n",
      "src/util.ts": "export const VERSION = '1.4.2';\n",
    });

    expect(signal(result, "hardcoded-secrets").value).toBe(0);
    expect(result.findings).toHaveLength(0);
    expect(result.score.score).toBe(0);
  });

  it("ignores a key that is labelled as an example", async () => {
    const result = await securityOf({
      "src/config.ts":
        `// example only, replace with your own\nexport const key = "${FAKE.aws}";\n`,
    });

    expect(signal(result, "hardcoded-secrets").value).toBe(0);
  });

  it("ignores keys in test files and generated output", async () => {
    const result = await securityOf({
      "src/auth.test.ts": `const key = "${FAKE.aws}";\n`,
      "src/schema.generated.ts": `const key = "${FAKE.stripe}";\n`,
      "src/index.ts": "export const x = 1;\n",
    });

    expect(signal(result, "hardcoded-secrets").value).toBe(0);
  });

  it("ignores keys shown in documentation", async () => {
    const result = await securityOf({
      "README.md": `Set your key:\n\n    AWS_ACCESS_KEY_ID=${FAKE.aws}\n`,
      "src/index.ts": "export const x = 1;\n",
    });

    expect(signal(result, "hardcoded-secrets").value).toBe(0);
  });

  it("does not fire on a high-entropy string that is not a credential", async () => {
    const result = await securityOf({
      "src/hashes.ts": [
        "export const SRI = 'sha512-TC8MkTuZUtcTSiFeuC0ksCh9QIJ5F21MvZ4Wn4ORfYaFJ0dsiudv5tVkejgwZlwQ39jL9WWDe2lz8x0WglOA==';",
        "export const COMMIT = '6d7dbf8a1c4e9b2f7a3d5e8c1b4f7a2d9e6c3b0f';",
        "export const ID = '3f2504e0-4f89-11d3-9a0c-0305e82c3301';",
      ].join("\n"),
    });

    expect(signal(result, "hardcoded-secrets").value).toBe(0);
  });
});

describe("committed .env", () => {
  it("flags a tracked .env holding real values", async () => {
    const result = await securityOf({
      ".env": "DATABASE_URL=postgres://admin:s3cr3tpw@db.internal:5432/prod\n",
      "src/index.ts": "export const x = 1;\n",
    });

    expect(signal(result, "committed-env").value).toBe(1);
    const finding = result.findings.find((f) => f.ruleId === "committed-env-file");
    expect(finding).toBeDefined();
    expect(finding!.severity).toBe("high");
  });

  it("ignores a .env that .gitignore covers", async () => {
    const result = await securityOf({
      LICENSE: MIT,
      ".gitignore": "node_modules\n.env\n",
      ".env": "DATABASE_URL=postgres://admin:s3cr3tpw@db.internal:5432/prod\n",
      "src/index.ts": "export const x = 1;\n",
    });

    expect(signal(result, "committed-env").value).toBe(0);
    expect(result.findings).toHaveLength(0);
  });

  it("ignores a .env covered by a wildcard rule", async () => {
    const result = await securityOf({
      ".gitignore": ".env*\n",
      ".env.production": "API_TOKEN=zk39fjs93jfkw93jfks93\n",
      "src/index.ts": "export const x = 1;\n",
    });

    expect(signal(result, "committed-env").value).toBe(0);
  });

  it("ignores .env.example", async () => {
    const result = await securityOf({
      ".env.example": "DATABASE_URL=postgres://user:password@localhost:5432/db\n",
      "src/index.ts": "export const x = 1;\n",
    });

    expect(signal(result, "committed-env").value).toBe(0);
  });

  it("ignores a committed .env of harmless defaults", async () => {
    const result = await securityOf({
      ".env": "NODE_ENV=development\nPORT=3000\nLOG_LEVEL=debug\n",
      "src/index.ts": "export const x = 1;\n",
    });

    expect(signal(result, "committed-env").value).toBe(0);
  });
});

describe("the dimension", () => {
  it("scores zero and stays confident on a clean repository", async () => {
    const result = await securityOf({
      LICENSE: MIT,
      "src/index.ts": "export const x = 1;\n",
      "src/other.ts": "export const y = 2;\n",
    });

    expect(result.score.dimension).toBe("security");
    expect(result.score.score).toBe(0);

    /*
     * Confidence is not "high", and that is the honest answer rather than a
     * shortfall. A library with no HTTP routes gives the route check nothing
     * to judge, this scan did not consult the vulnerability database, and with
     * no manifest there is no declared licence to compare the LICENSE file
     * against — so three of the seven checks had no input. The score stays 0
     * because a missing signal must never be read as a clean one; coverage
     * carries the gap instead, and says what it was.
     */
    expect(result.score.confidence).toBe("medium");
    expect(result.score.unavailable.join(" ")).toContain("no HTTP routes");
    expect(result.score.signals.filter((s) => s.available)).toHaveLength(4);
  });

  /*
   * Two implicated directories, not one. `computeHotspots` returns nothing
   * below `MIN_RESULTS`, because a single bar at full length says "strongest
   * here" about the only place there is — the behaviour added after
   * `sindresorhus/p-limit` rendered a lone `.` at 100%.
   */
  it("ranks the directory with the denser concentration first", async () => {
    const result = await securityOf({
      "packages/api/src/a.ts": `export const k = "${FAKE.aws}";\n`,
      "packages/api/src/b.ts": `export const j = "${FAKE.stripe}";\n`,
      "packages/api/src/c.ts": "export const y = 2;\n",
      "packages/web/src/d.ts": `export const z = "${FAKE.slack}";\n`,
      "packages/web/src/e.ts": "export const w = 4;\n",
      "packages/web/src/f.ts": "export const v = 5;\n",
      "packages/web/src/g.ts": "export const u = 6;\n",
    });

    const ranked = result.score.hotspots ?? [];
    expect(ranked.length).toBeGreaterThanOrEqual(2);
    expect(ranked[0]!.path).toBe("packages/api/src");
    expect(ranked[0]!.intensity).toBe(1);
    expect(ranked[1]!.intensity).toBeLessThan(1);
  });
});

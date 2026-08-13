import { afterEach, describe, expect, it } from "vitest";

import { isLicenseFile } from "../../ingest/guards";
import { buildContext } from "../../scan";
import { createFixtureRepo, type FixtureRepo } from "../../testing/fixture-repo";
import { analyzeSecurity } from "./index";
import { identifyLicense, licenseMatches } from "./license";

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

const MIT =
  "MIT License\n\nCopyright (c) 2026 Example\n\n" +
  "Permission is hereby granted, free of charge, to any person obtaining a copy\n" +
  "of this software and associated documentation files (the \"Software\"), to deal\n" +
  "in the Software without restriction.\n";

const AGPL =
  "                    GNU AFFERO GENERAL PUBLIC LICENSE\n" +
  "                       Version 3, 19 November 2007\n\n" +
  "  Copyright (C) 2007 Free Software Foundation, Inc.\n";

/**
 * The blind spot this check was built around.
 *
 * `LICENSE` has no extension and was in no filename list, so `isRelevantFile`
 * rejected it and the file never reached the index — the same shape as the
 * `deploy/id_rsa` bug, where the one file a check most exists to read was
 * invisible to it and nothing failed.
 */
describe("licence files reach the index", () => {
  it("recognises the names a licence is actually written under", () => {
    for (const name of [
      "LICENSE",
      "LICENCE",
      "license",
      "LICENSE.md",
      "LICENSE.txt",
      "LICENSE-MIT",
      "COPYING",
      "NOTICE",
      "UNLICENSE",
      "packages/core/LICENSE",
    ]) {
      expect(isLicenseFile(name), name).toBe(true);
    }
  });

  it("does not mistake source code for a licence", () => {
    // A licence *checker* is not a licence. Without the extension constraint,
    // `license.ts` would be read as the project's terms.
    for (const name of ["src/license.ts", "licenses.py", "licence.go"]) {
      expect(isLicenseFile(name), name).toBe(false);
    }
  });
});

describe("identifying a licence", () => {
  it("tells the GNU family apart", () => {
    /*
     * Every GNU licence contains "GNU ... GENERAL PUBLIC LICENSE", so ordering
     * decides the answer — and AGPL versus GPL is the entire reason anyone
     * checks, because the network-use clause is what makes it a business
     * question rather than a formality.
     */
    expect(identifyLicense(AGPL)).toBe("AGPL-3.0");
    expect(
      identifyLicense("GNU GENERAL PUBLIC LICENSE\nVersion 3, 29 June 2007"),
    ).toBe("GPL-3.0");
    expect(
      identifyLicense("GNU LESSER GENERAL PUBLIC LICENSE\nVersion 2.1"),
    ).toBe("LGPL-2.1");
  });

  it("matches text that is hard-wrapped mid-phrase", () => {
    // Licence files wrap at whatever width their author used, so a phrase
    // match against the raw text fails whenever a newline lands inside it.
    const wrapped =
      "Permission is hereby granted, free of charge,\nto any person obtaining a copy\n";
    expect(identifyLicense(wrapped)).toBe("MIT");
  });

  it("returns nothing rather than guessing", () => {
    expect(identifyLicense("Copyright 2026 Example. All rights reserved.\n")).toBe(
      undefined,
    );
  });
});

describe("comparing a declaration with the file", () => {
  it("accepts a dual licence that includes the file's licence", () => {
    // `(MIT OR Apache-2.0)` is a normal declaration and is not in conflict
    // with either of its own licence files.
    expect(licenseMatches("(MIT OR Apache-2.0)", "MIT")).toBe(true);
    expect(licenseMatches("MIT OR Apache-2.0", "Apache-2.0")).toBe(true);
  });

  it("accepts notation differences within one licence", () => {
    expect(licenseMatches("GPL-3.0", "GPL-3.0-only")).toBe(true);
    expect(licenseMatches("BSD", "BSD-3-Clause")).toBe(true);
  });

  it("still catches a real contradiction", () => {
    expect(licenseMatches("MIT", "AGPL-3.0")).toBe(false);
    expect(licenseMatches("Apache-2.0", "GPL-3.0")).toBe(false);
  });
});

describe("the licence signals", () => {
  it("fires when there is no licence at all", async () => {
    const result = await securityOf({
      "src/index.ts": "export const x = 1;\n",
    });

    expect(signal(result, "missing-license").value).toBe(1);
    const finding = result.findings.find((f) => f.ruleId === "missing-license");
    expect(finding).toBeDefined();
    // The absence of a file is observed, not inferred.
    expect(finding!.confidence).toBe("certain");
  });

  it("stays silent when a licence is present — the case that matters", async () => {
    const result = await securityOf({
      LICENSE: MIT,
      "package.json": JSON.stringify({ name: "demo", license: "MIT" }),
      "src/index.ts": "export const x = 1;\n",
    });

    expect(signal(result, "missing-license").value).toBe(0);
    expect(signal(result, "license-mismatch").value).toBe(0);
    expect(result.findings).toHaveLength(0);
  });

  it("catches a manifest that contradicts the licence file", async () => {
    const result = await securityOf({
      LICENSE: AGPL,
      "package.json": JSON.stringify({ name: "demo", license: "MIT" }),
      "src/index.ts": "export const x = 1;\n",
    });

    expect(signal(result, "license-mismatch").value).toBe(1);
    const finding = result.findings.find((f) => f.ruleId === "license-mismatch");
    expect(finding!.data.declared).toBe("MIT");
    expect(finding!.data.identified).toBe("AGPL-3.0");
  });

  it("reads a Rust manifest too", async () => {
    const result = await securityOf({
      LICENSE: AGPL,
      "Cargo.toml": '[package]\nname = "demo"\nlicense = "MIT"\n',
      "src/main.rs": "fn main() {}\n",
    });

    expect(signal(result, "license-mismatch").value).toBe(1);
  });

  it("prefers the root licence in a monorepo", async () => {
    /*
     * A per-package licence is normal. Comparing an arbitrary one against the
     * root manifest would manufacture a mismatch out of a repository that is
     * entirely consistent with itself.
     */
    const result = await securityOf({
      LICENSE: MIT,
      "package.json": JSON.stringify({ name: "root", license: "MIT" }),
      "packages/legacy/LICENSE": AGPL,
      "packages/legacy/src/index.ts": "export const x = 1;\n",
    });

    expect(signal(result, "license-mismatch").value).toBe(0);
  });

  it("reports unavailable rather than clean when it cannot compare", async () => {
    // Invariant 2: a check with no input lowers confidence, never the score.
    const result = await securityOf({
      LICENSE: MIT,
      "src/index.ts": "export const x = 1;\n",
    });

    const mismatch = signal(result, "license-mismatch");
    expect(mismatch.available).toBe(false);
    expect(mismatch.unavailableReason).toMatch(/no licence is declared/i);
  });

  it("does not call an unrecognised licence a mismatch", async () => {
    const result = await securityOf({
      LICENSE: "Copyright 2026 Example. Ask us before using this.\n",
      "package.json": JSON.stringify({ name: "demo", license: "MIT" }),
      "src/index.ts": "export const x = 1;\n",
    });

    expect(signal(result, "missing-license").value).toBe(0);
    expect(signal(result, "license-mismatch").available).toBe(false);
  });

  it("says plainly that dependency licences were not examined", async () => {
    // Half the question, and we cannot answer it — there is no batch licence
    // lookup and a per-package registry query is hundreds of requests.
    const result = await securityOf({ LICENSE: MIT });
    expect(result.warnings.join(" ")).toMatch(/dependency licences were not/i);
  });
});

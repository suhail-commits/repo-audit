import { describe, expect, it } from "vitest";

import { GitHubError, type RepoMeta } from "./ingest/github";
import { assertScannable } from "./scan";

function meta(overrides: Partial<RepoMeta> = {}): RepoMeta {
  return {
    slug: "owner/repo",
    defaultBranch: "main",
    sizeKb: 1_000,
    primaryLanguage: "TypeScript",
    isPrivate: false,
    isArchived: false,
    pushedAt: "2026-01-01T00:00:00Z",
    ...overrides,
  };
}

describe("assertScannable", () => {
  it("allows an ordinary public repository", () => {
    expect(() => assertScannable(meta(), 150_000)).not.toThrow();
  });

  it("refuses a private repository even though the API returned it", () => {
    /*
     * A deployment carries a GITHUB_TOKEN for the rate limit, and that token
     * has its owner's `repo` scope — so GitHub *will* hand back the owner's
     * private repositories to whoever types the slug into the public form.
     * Being able to read one is never the same as the visitor being allowed to.
     */
    expect(() => assertScannable(meta({ isPrivate: true }), 150_000)).toThrow(
      /private/i,
    );

    try {
      assertScannable(meta({ isPrivate: true }), 150_000);
    } catch (err) {
      expect(err).toBeInstanceOf(GitHubError);
      expect((err as GitHubError).status).toBe(403);
    }
  });

  it("refuses a private repository before it mentions the size", () => {
    // Reporting a size would itself disclose that the repository exists and
    // roughly how large it is, so the privacy gate must run first.
    expect(() =>
      assertScannable(meta({ isPrivate: true, sizeKb: 900_000 }), 150_000),
    ).toThrow(/private/i);
  });

  it("refuses a repository past the size limit with a readable message", () => {
    expect(() => assertScannable(meta({ sizeKb: 400_000 }), 150_000)).toThrow(
      /larger than/i,
    );
  });

  it("allows a repository exactly at the limit", () => {
    expect(() => assertScannable(meta({ sizeKb: 150_000 }), 150_000)).not.toThrow();
  });
});

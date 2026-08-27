import { describe, expect, it } from "vitest";

import { parseRepoBranch, parseRepoSlug } from "./slug";

describe("parseRepoSlug", () => {
  it("accepts the forms people actually paste", () => {
    for (const input of [
      "vercel/ms",
      "https://github.com/vercel/ms",
      "http://github.com/vercel/ms",
      "github.com/vercel/ms",
      "www.github.com/vercel/ms",
      "git@github.com:vercel/ms.git",
      "https://github.com/vercel/ms.git",
      "https://github.com/vercel/ms/",
    ]) {
      expect(parseRepoSlug(input), input).toBe("vercel/ms");
    }
  });

  it("drops everything past the repository segment", () => {
    expect(parseRepoSlug("https://github.com/vercel/ms/tree/main")).toBe("vercel/ms");
    expect(parseRepoSlug("https://github.com/vercel/ms/issues/12")).toBe("vercel/ms");
    expect(parseRepoSlug("https://github.com/vercel/ms?tab=readme")).toBe("vercel/ms");
  });

  it("rejects what is not a repository", () => {
    for (const input of ["", "   ", "vercel", "https://github.com", "../etc/passwd"]) {
      expect(parseRepoSlug(input), input).toBeNull();
    }
  });
});

describe("parseRepoBranch", () => {
  /*
   * The bug this exists for: `parseRepoSlug` drops everything past the repo
   * segment, so pasting the URL out of the address bar while looking at a
   * branch silently scanned the default one instead. The branch was in the
   * string the whole time.
   */
  it("recovers the branch a tree URL already names", () => {
    expect(parseRepoBranch("https://github.com/vercel/ms/tree/main")).toBe("main");
    expect(parseRepoBranch("https://github.com/vercel/ms/tree/next")).toBe("next");
    expect(parseRepoBranch("github.com/a/b/tree/v2")).toBe("v2");
  });

  it("keeps a branch name containing slashes intact", () => {
    // `feature/thing` is the most common naming convention there is, and a
    // tree URL renders it verbatim rather than escaping the separator.
    expect(parseRepoBranch("https://github.com/a/b/tree/feature/thing")).toBe(
      "feature/thing",
    );
    expect(parseRepoBranch("https://github.com/a/b/tree/paul/use-vitest")).toBe(
      "paul/use-vitest",
    );
  });

  it("returns null when no branch was named", () => {
    for (const input of [
      "vercel/ms",
      "https://github.com/vercel/ms",
      "https://github.com/vercel/ms/issues/12",
      "https://github.com/a/b/tree/",
    ]) {
      expect(parseRepoBranch(input), input).toBeNull();
    }
  });

  it("ignores a query string or fragment after the branch", () => {
    expect(parseRepoBranch("https://github.com/a/b/tree/main?foo=1")).toBe("main");
    expect(parseRepoBranch("https://github.com/a/b/tree/main#readme")).toBe("main");
  });
});

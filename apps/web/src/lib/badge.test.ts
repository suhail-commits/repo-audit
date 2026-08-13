import { describe, expect, it } from "vitest";

import { renderBadge } from "./badge";

describe("badge", () => {
  it("renders both halves as text, not only as colour", () => {
    const svg = renderBadge({ label: "vibe check", value: "17/100 unlikely" });
    expect(svg).toContain("vibe check");
    expect(svg).toContain("17/100 unlikely");
    expect(svg).toMatch(/^<svg /);
    expect(svg).toContain("</svg>");
  });

  it("escapes the repository name it was given", () => {
    /*
     * Both halves can carry values derived from a URL path, and the response is
     * served as `image/svg+xml` — which browsers parse as a document, so an
     * unescaped `<` is markup rather than text.
     */
    const svg = renderBadge({ label: 'a"<script>', value: "b&c" });
    expect(svg).not.toContain("<script>");
    expect(svg).toContain("&lt;script&gt;");
    expect(svg).toContain("b&amp;c");
  });

  it("widens to fit its text", () => {
    const short = width(renderBadge({ label: "x", value: "y" }));
    const long = width(
      renderBadge({ label: "vibe check", value: "100/100 near certain" }),
    );
    expect(long).toBeGreaterThan(short);
  });

  it("carries an accessible label", () => {
    const svg = renderBadge({ label: "vibe check", value: "0/100" });
    expect(svg).toContain('role="img"');
    expect(svg).toContain('aria-label="vibe check: 0/100"');
  });

  it("uses one neutral colour rather than a status ramp", () => {
    /*
     * The report's score scale makes the same choice for the same reason:
     * colouring a high authorship score red would assert that AI-generated code
     * is bad, which is a judgement this tool does not make. A badge is the most
     * quotable surface here, so it is the last place to start editorialising.
     */
    const clean = renderBadge({ label: "vibe check", value: "2/100 unlikely" });
    const high = renderBadge({
      label: "vibe check",
      value: "92/100 near certain",
    });
    expect(fills(clean)).toEqual(fills(high));
  });
});

const width = (svg: string) => Number(/width="(\d+)"/.exec(svg)?.[1] ?? 0);
const fills = (svg: string) =>
  [...svg.matchAll(/fill="(#[0-9a-f]{3,6})"/gi)].map((m) => m[1]);

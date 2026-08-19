import type { NextConfig } from "next";

const config: NextConfig = {
  // Workspace packages ship raw TypeScript (no build step), so Next must
  // transpile them rather than expecting compiled output.
  transpilePackages: ["@vibe/engine", "@vibe/rules", "@vibe/shared"],
  // Native bindings the bundler must not rewrite — both ship platform binaries.
  // web-tree-sitter loads its grammar from disk at runtime, so it must not be
  // bundled either.
  serverExternalPackages: [
    "oxc-parser",
    "oxc-resolver",
    "web-tree-sitter",
    "tree-sitter-wasms",
  ],

  /*
   * The tree-sitter grammars are .wasm assets located at runtime. Nothing
   * imports them, so tracing cannot infer them and they would be missing from
   * the deployment — Python, Go and Rust would silently drop to the history
   * tier, which is a wrong report rather than an error.
   *
   * **Both patterns are needed and they are not redundant.** The `.pnpm` one
   * matches the real files in the workspace store; the `node_modules/` one
   * matches where they are reachable from, and is the shape `grammarPath`'s
   * fallback in `packages/engine/src/index/structural.ts` actually looks for
   * when it walks up from `process.cwd()`. Tracing the store alone put the
   * bytes in the deployment at a path nothing would ever look at.
   */
  outputFileTracingIncludes: {
    "/api/scans": [
      "./node_modules/tree-sitter-wasms/out/*.wasm",
      "../../node_modules/.pnpm/**/tree-sitter-wasms/out/*.wasm",
    ],
  },
  typedRoutes: false,
};

export default config;

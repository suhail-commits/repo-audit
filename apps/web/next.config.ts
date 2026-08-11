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

  // The Python grammar is a .wasm asset resolved at runtime via require.resolve.
  // Nothing imports it, so file tracing cannot infer it and it would be missing
  // from the deployed bundle — Python would silently drop to the history tier.
  outputFileTracingIncludes: {
    "/api/scans": ["../../node_modules/.pnpm/**/tree-sitter-wasms/out/*.wasm"],
  },
  typedRoutes: false,
};

export default config;

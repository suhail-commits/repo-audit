import type { FileIndex } from "./files";

/**
 * Which frameworks a repo uses. Drives which security rules are worth running —
 * the Supabase RLS rule is meaningless on an Express + Postgres app.
 */
export interface FrameworkInfo {
  names: string[];
  /** Declared runtime + dev dependencies, name → version range. */
  dependencies: Record<string, string>;
  /**
   * Runtime dependencies only.
   *
   * Kept separate because "declared but never imported" only means something for
   * runtime deps. Dev dependencies are overwhelmingly CLI tools invoked from
   * scripts or config — `rollup`, `size-limit`, `xo`, `c8` — and flagging them
   * as unused fired on almost every real library we tested.
   */
  runtimeDependencies: Record<string, string>;
  /** Every package.json found, for monorepo/service detection. */
  manifestPaths: string[];
}

const DEPENDENCY_SIGNALS: Record<string, string> = {
  next: "next",
  react: "react",
  vue: "vue",
  svelte: "svelte",
  "@sveltejs/kit": "sveltekit",
  nuxt: "nuxt",
  express: "express",
  fastify: "fastify",
  hono: "hono",
  "@nestjs/core": "nestjs",
  "@supabase/supabase-js": "supabase",
  "@prisma/client": "prisma",
  "drizzle-orm": "drizzle",
  mongoose: "mongoose",
  typeorm: "typeorm",
  knex: "knex",
  "next-auth": "next-auth",
  "@auth/core": "authjs",
  "@clerk/nextjs": "clerk",
  "@clerk/clerk-sdk-node": "clerk",
  "firebase-admin": "firebase",
  stripe: "stripe",
  "@stripe/stripe-js": "stripe",
  tailwindcss: "tailwind",
  trpc: "trpc",
  "@trpc/server": "trpc",
  graphql: "graphql",
  socket_io: "socket.io",
};

export function detectFrameworks(files: FileIndex): FrameworkInfo {
  const names = new Set<string>();
  const dependencies: Record<string, string> = {};
  const runtimeDependencies: Record<string, string> = {};
  const manifestPaths: string[] = [];

  for (const file of files.all()) {
    if (!file.relPath.endsWith("package.json")) continue;
    if (file.relPath.includes("node_modules/")) continue;
    manifestPaths.push(file.relPath);

    let pkg: {
      dependencies?: Record<string, string>;
      devDependencies?: Record<string, string>;
    };
    try {
      pkg = JSON.parse(file.content);
    } catch {
      continue;
    }

    for (const [name, range] of Object.entries(pkg.dependencies ?? {})) {
      runtimeDependencies[name] = range;
    }

    for (const [name, range] of Object.entries({
      ...(pkg.dependencies ?? {}),
      ...(pkg.devDependencies ?? {}),
    })) {
      dependencies[name] = range;
      const signal = DEPENDENCY_SIGNALS[name];
      if (signal) names.add(signal);
    }
  }

  // Layout-based detection catches projects whose manifest we could not parse.
  const paths = files.all().map((f) => f.relPath);
  if (paths.some((p) => /^(src\/)?app\/.*\/route\.[cm]?[jt]sx?$/.test(p))) {
    names.add("next");
  }
  if (paths.some((p) => /^(src\/)?pages\/api\//.test(p))) names.add("next");
  if (paths.some((p) => /^supabase\/migrations\//.test(p))) names.add("supabase");
  if (paths.some((p) => p.endsWith("schema.prisma"))) names.add("prisma");
  if (paths.some((p) => /^docker-compose\.ya?ml$/.test(p))) names.add("docker");

  return {
    names: [...names].sort(),
    dependencies,
    runtimeDependencies,
    manifestPaths: manifestPaths.sort(),
  };
}

/**
 * Declared dependencies that no file in the repo actually imports.
 *
 * A strong vibe-coding tell: an agent adds a package to package.json for an
 * approach it then abandons, and nothing ever removes it.
 */
export function unusedDependencies(
  info: FrameworkInfo,
  importedPackages: Set<string>,
  /**
   * Packages named in a string literal somewhere in the source.
   *
   * Not every use of a package is an import. A specifier assembled at runtime —
   * `["tree-sitter-wasms", "out", name].join("/")` — resolves a real dependency
   * and produces no import record, and this repository does exactly that,
   * deliberately, because handing Turbopack a literal makes it try to bundle a
   * `.wasm`. So the tool reported its own documented workaround as an unused
   * dependency.
   *
   * The same shape covers plugin names in config, `require.resolve` on a data
   * file, and anything loaded through a registry of strings.
   */
  mentionedPackages: Set<string> = new Set(),
): string[] {
  // Packages that legitimately never appear in an import statement: toolchain
  // entries invoked via CLI, and runtime deps the framework wires up itself.
  // `react`/`react-dom` matter most here — under the modern JSX transform a
  // component file uses React without importing it.
  const IMPLICIT = new Set([
    "typescript",
    "tailwindcss",
    "postcss",
    "autoprefixer",
    "eslint",
    "prettier",
    "vitest",
    "jest",
    "@types/node",
    "next",
    "react",
    "react-dom",
    "husky",
    "lint-staged",
    "tsx",
    "nodemon",
    "concurrently",
    "dotenv",
    "dotenv-cli",
    "@biomejs/biome",
    "vite",
    "esbuild",
    "rimraf",
    "cross-env",
  ]);

  // Runtime dependencies only — see FrameworkInfo.runtimeDependencies.
  return Object.keys(info.runtimeDependencies)
    .filter((name) => !IMPLICIT.has(name))
    .filter((name) => !name.startsWith("@types/"))
    .filter((name) => !name.startsWith("eslint-"))
    .filter((name) => !name.startsWith("@tailwindcss/"))
    .filter((name) => !importedPackages.has(name))
    .filter((name) => !mentionedPackages.has(name))
    .sort();
}

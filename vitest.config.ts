import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    /*
     * `apps/*` as well as `packages/*`. The pattern covered only packages, so a
     * test written beside web code was collected by nothing and passed by
     * default — the same shape as `pnpm typecheck` silently skipping the entire
     * web app, which is in *Environment gotchas* for the same reason.
     */
    include: ["packages/*/src/**/*.test.ts", "apps/*/src/**/*.test.ts"],
    // Repo scans touch the filesystem and shell out to git; give them room.
    testTimeout: 30_000,
  },
});

import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["packages/*/src/**/*.test.ts"],
    // Repo scans touch the filesystem and shell out to git; give them room.
    testTimeout: 30_000,
  },
});

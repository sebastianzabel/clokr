import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    globals: true,
    environment: "node",
    root: "./src",
    include: ["**/*.test.ts"],
    // Integration tests share a DB, so run sequentially
    fileParallelism: false,
    testTimeout: 30000,
    globalSetup: ["../vitest.setup.ts"],
    coverage: {
      provider: "v8",
      include: ["**/*.ts"],
      exclude: ["**/*.test.ts", "**/index.ts"],
      // Thresholds set 4pp below baseline measured 2026-03-30:
      // lines=41.74%, functions=41.05%, branches=28.48%
      thresholds: {
        lines: 37,
        functions: 37,
        branches: 24,
      },
    },
  },
});

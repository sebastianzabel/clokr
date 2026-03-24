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
    coverage: {
      provider: "v8",
      include: ["**/*.ts"],
      exclude: ["**/*.test.ts", "**/index.ts"],
    },
  },
});

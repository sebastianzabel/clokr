import { defineConfig } from "vitest/config";

// The adapter has its own config on purpose: without one, vitest walks up to the repo-root
// vitest.config.mjs and collects ITS include globs (scripts/**, one apps/api script test), so
// "pnpm --filter @clokr/fritzbox-adapter test" found no adapter test at all (Issue #610).
// Pure unit tests only: stubbed TR-064 and API, no non-loopback socket, no network.
// .mjs (not .ts): the adapter's tsconfig has rootDir src, so no type-aware lint project
// covers a TypeScript config at the package root.
export default defineConfig({
  test: { include: ["src/**/*.test.ts"], environment: "node" },
});

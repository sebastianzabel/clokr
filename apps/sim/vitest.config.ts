import { defineConfig } from "vitest/config";

// Pure unit tests only: nothing here opens a database or a socket. The invariants that need the
// real schema are proven in apps/api/scripts/__tests__/sim-invariants-715.test.ts, which owns the
// test-database harness.
export default defineConfig({
  test: { include: ["test/**/*.test.ts"], environment: "node" },
});

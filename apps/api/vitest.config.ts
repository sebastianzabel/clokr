import { defineConfig } from "vitest/config";
import { TEST_DATABASE_WORKER_COUNT } from "./src/utils/test-database";

export default defineConfig({
  test: {
    globals: true,
    environment: "node",
    root: "./",
    include: ["src/**/*.test.ts", "scripts/**/*.test.ts"],
    // Phase 106 (D-01/D-02): every worker owns its own database (clokr_test_<VITEST_POOL_ID>,
    // cloned from the migrated clokr_test template by scripts/reset-test-databases.ts), so the
    // "integration tests share a DB" reason for running sequentially no longer exists.
    fileParallelism: true,
    // A literal integer, never a percentage and never os.availableParallelism(): D-02 requires the
    // SAME worker count in CI and on every developer machine, because test:setup provisions exactly
    // TEST_DATABASE_WORKER_COUNT databases. A machine with more cores deliberately leaves
    // performance unused. Derived from the runner's MEASURED nproc/RAM — see 106-MEASUREMENTS.md.
    maxWorkers: TEST_DATABASE_WORKER_COUNT,
    testTimeout: 30000,
    globalSetup: ["./vitest.setup.ts"],
    // TI-03 layer 2 (Phase 101 plan 02): re-asserts inside every worker, once per test file, that
    // the target globalSetup verified actually propagated there — a propagation check, not an
    // authorisation control. See vitest.worker-setup.ts's own header comment.
    // Task 34: vitest.clock-setup.ts is a NEW first entry (opt-in fake-clock
    // harness, no-op unless CLOKR_TEST_FAKE_CLOCK is set) — must run before
    // vitest.worker-setup.ts and before any test module is imported, since
    // several test files compute module-level constants like
    // `const TODAY = new Date()` at import time.
    setupFiles: ["./vitest.clock-setup.ts", "./vitest.worker-setup.ts"],
    coverage: {
      provider: "v8",
      include: ["src/**/*.ts"],
      exclude: ["**/*.test.ts", "**/index.ts"],
      // Thresholds enforce per DEVOPS-V8-03 (lines >= 40); baseline measured 2026-03-30: lines=41.74%, functions=41.05%, branches=28.48%
      thresholds: {
        lines: 40,
        functions: 37,
        branches: 24,
      },
    },
  },
});

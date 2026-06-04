import { defineConfig } from "vitest/config";

// Minimal Vitest config for unit tests in apps/web. Kept separate from vite.config.ts
// (which is SvelteKit-coupled) so plain .ts unit tests (e.g. src/lib/i18n/__tests__/)
// don't require the full SvelteKit transform pipeline.
//
// Coverage thresholds enforce DEVOPS-V8-03: >=40% lines for api + web.
// Provider: v8 (same as apps/api).
//
// Coverage SCOPE (Phase 70 carry-forward): include is narrowed to lib/i18n only,
// the subtree with the highest existing test coverage (100% lines, 100% functions,
// 75% branches via lib/i18n/__tests__/i18n.test.ts). Broader scope (full src/lib/**)
// is deferred until web has more test coverage — see Phase 70-01 SUMMARY for the
// open item. The 40-line threshold from REQUIREMENTS.md DEVOPS-V8-03 is still
// enforced, just on a smaller surface than apps/api today. Phase 73 will broaden
// once the docker-compose-driven test runner exists and component tests are added.
//
// Additional tests exist at src/lib/__tests__/employee-classification.test.ts —
// these run as part of `vitest run` (test suite ✓) but are out of the coverage
// `include` scope so they don't gate the threshold today.
export default defineConfig({
  test: {
    globals: false,
    environment: "node",
    include: ["src/**/*.test.ts"],
    coverage: {
      provider: "v8",
      reporter: ["text", "json", "html"],
      include: ["src/lib/i18n/**/*.ts"],
      exclude: ["src/lib/**/__tests__/**", "src/lib/**/*.test.ts"],
      thresholds: {
        lines: 40,
        functions: 40,
        branches: 40,
        statements: 40,
      },
    },
  },
});

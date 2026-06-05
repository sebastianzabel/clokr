import { defineConfig } from "vitest/config";
import { svelte, vitePreprocess } from "@sveltejs/vite-plugin-svelte";
import path from "node:path";

// Vitest config for apps/web — jsdom-based, Svelte 5 runes compatible.
//
// Why a separate file from vite.config.ts? vite.config.ts uses sveltekit() which
// pulls in the full server/router pipeline. Component tests don't need routing —
// they need the bare Svelte compiler + jsdom. Keeping configs split avoids
// SvelteKit's "$app/*" alias errors at test resolution time.
//
// Preprocessor: uses vitePreprocess() from @sveltejs/vite-plugin-svelte (same as
// apps/web/svelte.config.js) — no svelte-preprocess dependency required.
//
// Coverage SCOPE (Phase 76, D-05):
// - include: src/lib/**/*.{ts,svelte}  (where component + util logic lives)
// - exclude: __tests__ + *.test.ts + src/routes/** (routes are E2E territory, Phase 74)
// - Threshold lines >= 40 mirrors apps/api and is the v1.8 milestone floor.
//   Phase 76-03 adds a hard CI gate via scripts/check-coverage.mjs.
//
// Hooks for component tests (D-06): every test that renders a component wraps it
// in <div data-theme="pflaume"> via apps/web/src/__tests__/test-utils.ts to catch
// token regressions at unit level.
//
// NOTE on thresholds: Vitest's threshold check will warn (and eventually fail) if
// coverage is under the configured floor. Plans 76-02 + 76-03 add the actual
// component tests that achieve >= 40% on src/lib/**. If Plan 76-01 lands alone in
// CI before then, expect a warning but not a hard failure until 76-03 ratchets the
// CI gate via scripts/check-coverage.mjs.
export default defineConfig({
  plugins: [
    svelte({
      // HMR is auto-disabled by vite-plugin-svelte when Vitest is running
      // (no top-level `hot` option in v7 — it was removed in favour of
      // automatic detection). Preprocessor mirrors svelte.config.js.
      preprocess: vitePreprocess(),
    }),
  ],
  test: {
    globals: false,
    environment: "jsdom",
    include: ["src/**/*.test.ts"],
    setupFiles: ["src/__tests__/setup.ts"],
    // jsdom + Svelte compilation is heavier than node; raise timeout
    testTimeout: 15000,
    coverage: {
      provider: "v8",
      reporter: ["text", "json", "json-summary", "html"],
      include: ["src/lib/**/*.ts", "src/lib/**/*.svelte"],
      exclude: [
        "src/lib/**/__tests__/**",
        "src/lib/**/*.test.ts",
        "src/lib/**/*.d.ts",
        "src/lib/api/client.ts", // pure HTTP wrapper, covered by E2E (Phase 74)
      ],
      thresholds: {
        lines: 40,
        functions: 35,
        branches: 30,
        statements: 40,
      },
    },
  },
  resolve: {
    alias: {
      $lib: path.resolve(__dirname, "./src/lib"),
      $components: path.resolve(__dirname, "./src/lib/components"),
      $stores: path.resolve(__dirname, "./src/lib/stores"),
      $api: path.resolve(__dirname, "./src/lib/api"),
      $tests: path.resolve(__dirname, "./src/__tests__"),
    },
  },
});

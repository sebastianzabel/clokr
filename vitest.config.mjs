import { defineConfig } from "vitest/config";

// Root-level vitest config for repo-wide scripts (scripts/**) — distinct from
// apps/api/vitest.config.ts and apps/web/vitest.config.ts. Neither app-scoped config fits:
// apps/api's include pattern already covers `scripts/**/*.test.ts` but that instance owns
// the shared integration test databases (see docs/testing.md) and must never be piggybacked
// for unrelated node-script unit tests; apps/web's is jsdom + Svelte-compiler scoped to
// `src/**` only. scripts/lint-comment-language.mjs itself scans BOTH apps/api/src and
// apps/web/src, so its tests belong at the root, not inside either app.
//
// Run via `pnpm test:scripts` (root package.json) — plain node environment, no DB/Svelte
// setup needed since these are pure-function unit tests.
export default defineConfig({
  test: {
    globals: true,
    environment: "node",
    include: ["scripts/**/*.test.mjs"],
  },
});

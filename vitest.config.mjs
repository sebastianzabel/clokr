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
//
// PR #297: apps/api/scripts/__tests__/lint-guard-vacuity.test.ts is included from here for
// exactly the reason the paragraph above gives. It is a pure AST-classifier test (its only
// imports are node:fs/node:url/node:path plus the two lint-guard-vacuity modules) and it
// resolves the repo root from `import.meta.url`, never from cwd — so it is cwd-independent
// and genuinely DB-free. But apps/api's vitest instance owns the shared integration test
// databases, and its globalSetup (apps/api/vitest.setup.ts -> scripts/test-database-guard.ts)
// refuses to start unless clokr_test and every worker database exists. Those are provisioned
// by a CI step gated on `steps.changes.outputs.api == 'true'`, so running this test through
// apps/api made an UNCONDITIONAL gate depend on a CONDITIONAL precondition: on a web-only PR
// it died with `database "clokr_test" does not exist`. PR #290 fixed a gate whose trigger was
// narrower than its scope and introduced the mirror image of the same mistake. Running it here
// removes the precondition instead of widening it — no postgres, no migrations, no API suite
// on a web-only change.
export default defineConfig({
  test: {
    globals: true,
    environment: "node",
    include: [
      "scripts/**/*.test.mjs",
      // See the PR #297 paragraph above — DB-free by construction, kept off apps/api's
      // database-owning vitest instance on purpose.
      "apps/api/scripts/__tests__/lint-guard-vacuity.test.ts",
    ],
  },
});

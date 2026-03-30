# Phase 1: Test Infrastructure - Research

**Researched:** 2026-03-30
**Domain:** Vitest / Playwright / ESLint / PostgreSQL schema isolation / Docker seed fix
**Confidence:** HIGH

---

<user_constraints>

## User Constraints (from CONTEXT.md)

### Locked Decisions

- **D-01:** Use the same PostgreSQL instance with a separate schema (not a separate container). Local dev uses `test` schema via `TEST_DATABASE_URL` with `?schema=test` parameter.
- **D-02:** Production deployment is on k3s cluster via GitHub Actions — CI test isolation follows the same pattern (same PG, separate schema).
- **D-03:** Claude's choice — select the best cleanup approach based on Prisma 7 compatibility. Research should evaluate truncate-per-suite vs transaction rollback given Prisma's connection model and the audit-proof requirement (audit log assertions must survive test transactions).
- **D-04:** Measure baseline first, then set thresholds slightly above current coverage. Don't set aspirational targets that break CI immediately.
- **D-05:** Enable `@typescript-eslint/no-floating-promises` as error (not warn). This directly addresses the known `.catch(() => {})` tech debt.
- **D-06:** Replace all `.catch(() => {})` with `app.log.error({ err }, "context message")` at the 4 confirmed locations plus any others found during implementation.
- **D-07:** Fix seed compilation for pnpm@10 + Prisma 7. Must work in both local Docker and k3s production images.

### Claude's Discretion

- Exact coverage threshold numbers (after baseline measurement)
- Additional ESLint rules beyond `no-floating-promises` if beneficial
- Playwright `storageState` implementation details
- Test cleanup approach (truncate vs rollback)

### Deferred Ideas (OUT OF SCOPE)

None — discussion stayed within phase scope
</user_constraints>

---

<phase_requirements>

## Phase Requirements

| ID       | Description                                                                     | Research Support                                                                                                                                                     |
| -------- | ------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| TEST-01  | Isolated test database via `TEST_DATABASE_URL` (no shared dev DB)               | D-01/D-02: same PG, `?schema=test` parameter; prisma.config.ts pattern for schema switching                                                                          |
| TEST-02  | Playwright `storageState` setup project (auth once, reuse across E2E specs)     | Setup project with `dependencies` array; `.auth/admin.json` saved once before all projects                                                                           |
| TEST-03  | Vitest coverage thresholds enforced (baseline measurement first)                | D-04: `coverage.thresholds` in vitest.config.ts; `@vitest/coverage-v8` already installed                                                                             |
| TEST-04  | ESLint `no-floating-promises` rule enabled and blocking                         | D-05: add to `eslint.config.js` global rules block; requires `parserOptions.project` for type-aware rules                                                            |
| AUDIT-01 | Eliminate all silent `.catch(() => {})` patterns (replace with `app.log.error`) | D-06: 4 confirmed locations — auth.ts:42, overtime.ts:36, time-entries.ts:200, terminals.ts:110                                                                      |
| AUDIT-03 | Docker seed script fix (pnpm@10 + Prisma 7 compatibility) (GitHub #119)         | D-07: `2>/dev/null \|\| true` suppresses compile errors; seed.ts imports `../generated/client` which needs adapter-pg; fix is to compile properly via package script |

</phase_requirements>

---

## Summary

This phase establishes reliable test infrastructure before any feature test coverage work begins. Three distinct tracks run in dependency order: (1) database isolation, (2) ESLint + silent-catch cleanup, and (3) Docker seed fix. The Playwright storageState work is independent of the database isolation work.

The existing test setup in `apps/api/src/__tests__/setup.ts` already uses a per-tenant isolation approach (unique `slug` per test, `cleanupTestData` in `afterAll`). The critical gap is that `DATABASE_URL` points to the dev database — `process.env.DATABASE_URL` in `prisma.ts` plugin with no override for test runs. Fixing this requires: (1) a `TEST_DATABASE_URL` env var using PostgreSQL schema isolation (`?schema=test`), (2) the Vitest config or a `vitest.setup.ts` global that sets `process.env.DATABASE_URL = process.env.TEST_DATABASE_URL` before the app boots, and (3) `prisma db push --schema-only` against the test schema before tests run.

The ESLint hardening for `@typescript-eslint/no-floating-promises` requires type-aware linting (`parserOptions.project` in the ESLint flat config). The current `eslint.config.js` does not pass `project` to the TypeScript parser, so this must be added. Once enabled, all 4 `.catch(() => {})` instances will produce lint errors, so they must be replaced first.

**Primary recommendation:** Address in this order — (1) set `DATABASE_URL` override in Vitest setup file, (2) run `prisma db push` against test schema, (3) replace all `.catch(() => {})` instances, (4) add `parserOptions.project` and enable `no-floating-promises` as error, (5) run coverage baseline and set thresholds, (6) add Playwright storageState setup project, (7) fix Docker seed compilation.

---

## Standard Stack

### Core

| Library             | Version            | Purpose                         | Why Standard                                              |
| ------------------- | ------------------ | ------------------------------- | --------------------------------------------------------- |
| vitest              | ^4.1.2 (root)      | Test runner for API             | Already installed; `@vitest/coverage-v8` at same version  |
| @vitest/coverage-v8 | ^4.1.1 (root)      | Coverage provider               | Already installed; V8 native, no instrumentation overhead |
| @playwright/test    | ^1.58.2 (e2e)      | E2E browser testing             | Already installed                                         |
| typescript-eslint   | ^8.57.2 (root)     | Type-aware lint rules           | Already installed; provides `no-floating-promises`        |
| eslint              | ^10.1.0 (root)     | Linter                          | Already installed                                         |
| prisma              | ^7.6.0 (@clokr/db) | ORM; schema push to test schema | Already installed                                         |

### Supporting

| Library | Version | Purpose                                 | When to Use                              |
| ------- | ------- | --------------------------------------- | ---------------------------------------- |
| dotenv  | ^17.3.1 | Load `.env.test` in vitest global setup | vitest.config.ts `globalSetup` or inline |
| tsx     | ^4.21.0 | TypeScript execution for seed           | Dev-only; available in build stage       |

### Alternatives Considered

| Instead of                                   | Could Use                   | Tradeoff                                                                                           |
| -------------------------------------------- | --------------------------- | -------------------------------------------------------------------------------------------------- |
| PostgreSQL schema isolation (`?schema=test`) | Separate PG container       | Container approach requires docker-compose changes; schema approach uses same PG instance per D-01 |
| Truncate-per-suite (recommended)             | Transaction rollback        | Rollback conflicts with Fastify singleton + `app.inject()` pattern and breaks audit log assertions |
| `@vitest/coverage-v8`                        | `@vitest/coverage-istanbul` | V8 is already installed; istanbul requires Babel transform — avoid                                 |

**Installation:** No new packages required. All tools are already installed.

---

## Architecture Patterns

### Recommended Project Structure Changes

```
apps/api/
├── .env.test                    # NEW: TEST_DATABASE_URL=...?schema=test
├── vitest.config.ts             # MODIFIED: globalSetup, coverage.thresholds
├── vitest.setup.ts              # NEW: sets DATABASE_URL from TEST_DATABASE_URL
└── src/__tests__/
    └── setup.ts                 # MODIFIED: cleanup in try/finally

apps/e2e/
├── .auth/                       # NEW: gitignored; stores storageState JSON
│   └── admin.json               # created by auth.setup.ts at runtime
├── playwright.config.ts         # MODIFIED: add setup project + storageState
└── tests/
    └── auth.setup.ts            # NEW: logs in once, saves storageState

packages/db/
└── src/seed.ts                  # no changes — seed fix is in Dockerfile + entrypoint

apps/api/Dockerfile              # MODIFIED: remove `2>/dev/null || true`
apps/api/docker-entrypoint.sh    # MODIFIED: fail loudly on seed error
eslint.config.js                 # MODIFIED: parserOptions.project + no-floating-promises rule
```

### Pattern 1: PostgreSQL Schema Isolation via URL Parameter

**What:** Prisma supports per-schema isolation in PostgreSQL using the `?schema=NAME` connection string parameter. All tables are created in the named schema, leaving the default `public` schema (dev DB) untouched.

**When to use:** Whenever the same PG instance must serve both dev and test workloads (D-01).

**Implementation:**

```
# apps/api/.env.test
TEST_DATABASE_URL="postgresql://clokr:password@localhost:5432/clokr?schema=test"
```

The Vitest setup file must override `DATABASE_URL` before the app boots:

```typescript
// apps/api/vitest.setup.ts
import { config } from "dotenv";
import { resolve } from "path";

// Load .env.test overrides
config({ path: resolve(__dirname, "../.env.test") });

// Override DATABASE_URL for test runs — prisma plugin reads process.env.DATABASE_URL
if (process.env.TEST_DATABASE_URL) {
  process.env.DATABASE_URL = process.env.TEST_DATABASE_URL;
}
```

Wire this into `vitest.config.ts`:

```typescript
// apps/api/vitest.config.ts
export default defineConfig({
  test: {
    globalSetup: ["./vitest.setup.ts"],
    // ... rest of config
  },
});
```

**CRITICAL:** The `prisma db push` for the test schema must run before tests:

```bash
# One-time or pre-test setup
TEST_DATABASE_URL="postgresql://clokr:password@localhost:5432/clokr?schema=test" \
  pnpm --filter @clokr/db exec prisma db push
```

This can be driven by a `pretest` script in `apps/api/package.json`.

**Confidence:** HIGH — Prisma `?schema=` is documented PostgreSQL behaviour; confirmed used in production Prisma projects.

### Pattern 2: Truncate-Per-Suite (D-03 Recommendation)

**What:** After each test suite (`afterAll`), call `cleanupTestData` inside a `try/finally` block to guarantee cleanup even on test failure.

**Why NOT transaction rollback:**

- Prisma 7 uses a connection pool (`PrismaPg` adapter with `pg.Pool`). Transactions are not automatically shared across pool connections. A transaction opened in test setup would not wrap the Fastify HTTP request's database operations, which use a different pool connection.
- Audit log assertions require that records persist after the operation — wrapping in a rolled-back transaction would delete them, breaking tests that assert `app.audit()` wrote a row.
- The existing `cleanupTestData` function is comprehensive and already tested implicitly by the test suite running correctly.

**Required change — add try/finally:**

```typescript
// Pattern for every test file
afterAll(async () => {
  try {
    await cleanupTestData(testApp, tenant.id);
  } catch (err) {
    console.error("Cleanup failed:", err);
  }
});
```

**Confidence:** HIGH — based on Prisma connection model analysis; transaction rollback limitation is a known Prisma constraint with connection pooling.

### Pattern 3: Vitest Coverage Thresholds

**What:** `coverage.thresholds` in `vitest.config.ts` causes `vitest run --coverage` to exit non-zero if coverage drops below the specified percentages.

**Baseline measurement first (D-04):**

```bash
pnpm --filter @clokr/api test:coverage
```

Examine the output, then set thresholds 2-5 percentage points below current values.

**Config pattern:**

```typescript
// vitest.config.ts
coverage: {
  provider: "v8",
  include: ["**/*.ts"],
  exclude: ["**/*.test.ts", "**/index.ts"],
  thresholds: {
    lines: 65,       // set after baseline measurement
    functions: 65,   // set after baseline measurement
    branches: 55,    // set after baseline measurement
  },
},
```

**Confidence:** HIGH — documented Vitest coverage threshold API.

### Pattern 4: ESLint Type-Aware Rules (no-floating-promises)

**What:** `@typescript-eslint/no-floating-promises` requires that every Promise is either `await`ed, returned, or explicitly handled with `.catch()` that has a real body. It is a TYPE-AWARE rule — it needs TypeScript type information.

**Critical prerequisite:** The current `eslint.config.js` does NOT pass `parserOptions.project` to the TypeScript parser. Type-aware rules will silently not fire without it.

```javascript
// eslint.config.js — add to the global TypeScript block
{
  files: ["**/*.ts"],
  languageOptions: {
    parserOptions: {
      project: true,           // auto-discovers tsconfig.json
      tsconfigRootDir: import.meta.dirname,
    },
  },
  rules: {
    "@typescript-eslint/no-floating-promises": "error",
    // Optional additions that complement no-floating-promises:
    "@typescript-eslint/no-misused-promises": "error",
  },
},
```

**IMPORTANT — replace BEFORE enabling the rule:** All 4 `.catch(() => {})` instances will immediately fail linting. These must be replaced first (AUDIT-01 task), then the rule enabled.

**Exclusion for Svelte files:** `no-floating-promises` does not apply to `.svelte` files in the same way — ensure the `files: ["**/*.ts"]` scope is precise.

**Confidence:** HIGH — typescript-eslint documentation; `parserOptions.project` requirement is documented.

### Pattern 5: Playwright storageState Setup Project

**What:** Playwright supports a "setup" project dependency that runs once before all browser projects. The setup project logs in and saves the browser storage state (cookies + localStorage) to a file. All subsequent test projects load that file, skipping login.

```typescript
// playwright.config.ts
projects: [
  {
    name: "setup",
    testMatch: /auth\.setup\.ts/,
  },
  {
    name: "desktop-chrome",
    use: {
      ...devices["Desktop Chrome"],
      storageState: ".auth/admin.json",
    },
    dependencies: ["setup"],
  },
  {
    name: "mobile-chrome",
    use: {
      ...devices["Pixel 7"],
      storageState: ".auth/admin.json",
    },
    dependencies: ["setup"],
  },
  {
    name: "tablet",
    use: {
      ...devices["iPad (gen 7)"],
      storageState: ".auth/admin.json",
    },
    dependencies: ["setup"],
  },
],
```

```typescript
// apps/e2e/tests/auth.setup.ts
import { test as setup } from "@playwright/test";
import { login } from "./helpers";

const AUTH_FILE = ".auth/admin.json";

setup("authenticate as admin", async ({ page }) => {
  await login(
    page,
    process.env.TEST_ADMIN_EMAIL || "admin@clokr.de",
    process.env.TEST_ADMIN_PASSWORD || "Admin123!Pass",
  );
  await page.context().storageState({ path: AUTH_FILE });
});
```

```
# apps/e2e/.gitignore (add)
.auth/
```

**Confidence:** HIGH — Playwright official documentation pattern; `storageState` with `dependencies` is the current canonical approach.

### Pattern 6: Docker Seed Fix (AUDIT-03)

**Root cause (Pitfall 9):** Line 33 of `apps/api/Dockerfile`:

```dockerfile
RUN mkdir -p packages/db/dist && \
    npx tsc packages/db/src/seed.ts --outDir packages/db/dist --esModuleInterop --module commonjs --target es2020 --skipLibCheck 2>/dev/null || true
```

The `2>/dev/null || true` suppresses TypeScript compile errors silently. The `seed.ts` uses:

- `import { PrismaClient } from "../generated/client"` — relative path that may not resolve when compiled with a standalone `tsc` invocation outside the package context
- `import { PrismaPg } from "@prisma/adapter-pg"` — requires the adapter-pg module to be importable
- The `packages/db/package.json` has a `"seed": "tsx src/seed.ts"` script — this is the correct compilation path

**Fix approach:**

Option A (preferred): Add a `"seed:build"` script to `packages/db/package.json` and call it from the Dockerfile:

```json
// packages/db/package.json
"seed:build": "tsc --project tsconfig.seed.json"
```

With a dedicated `tsconfig.seed.json`:

```json
{
  "extends": "./tsconfig.json",
  "compilerOptions": {
    "outDir": "dist",
    "module": "commonjs",
    "moduleResolution": "node",
    "esModuleInterop": true,
    "target": "es2020"
  },
  "include": ["src/seed.ts"]
}
```

Dockerfile line becomes:

```dockerfile
RUN pnpm --filter @clokr/db run seed:build
```

(No `|| true`. Fails loudly if compilation fails.)

Option B (simpler): Keep using `tsx` but install it in the runtime stage as a dependency:

- Downside: adds dev tooling to the production image

**Recommended: Option A.** Fail loudly; compile with proper module resolution context.

**docker-entrypoint.sh change:** Remove the `tsx` fallback path and its suppression:

```sh
if [ -f "dist/seed.js" ]; then
  node dist/seed.js || echo "ℹ️  Seed skipped (may already exist)"
else
  echo "❌ dist/seed.js not found — seed compilation must have failed at build time"
  exit 1
fi
```

**Confidence:** MEDIUM — based on Dockerfile + seed.ts analysis. Actual compilation failure mode needs to be confirmed by attempting the build; the fix pattern is standard.

### Anti-Patterns to Avoid

- **Setting coverage thresholds before measuring baseline:** Will break CI immediately and cause the wrong first impression of the test suite.
- **Enabling `no-floating-promises` before replacing `.catch(() => {})` instances:** Lint will fail before any other work is complete — fix AUDIT-01 first.
- **Using transaction rollback for test isolation with Prisma PrismaPg:** The connection pool prevents transaction sharing across the Fastify request context. Truncate-per-suite is the correct approach.
- **Storing `.auth/admin.json` in git:** Contains JWT tokens. Must be in `.gitignore`.
- **Running `prisma db push` against the dev database when `TEST_DATABASE_URL` is not set:** The pretest script must guard against an empty `TEST_DATABASE_URL`.

---

## Don't Hand-Roll

| Problem             | Don't Build                   | Use Instead                               | Why                                                  |
| ------------------- | ----------------------------- | ----------------------------------------- | ---------------------------------------------------- |
| Coverage thresholds | Custom post-processing script | `vitest.config.ts coverage.thresholds`    | Vitest natively fails on threshold breach            |
| Test auth state     | Login in every test spec      | Playwright `storageState` + setup project | Built-in Playwright pattern; saves 60-80% E2E time   |
| Promise linting     | Code review / grep            | `@typescript-eslint/no-floating-promises` | Static analysis catches every callsite automatically |
| Schema isolation    | Separate PG container         | `?schema=test` URL parameter              | Zero infrastructure change; Prisma-native            |

**Key insight:** Every problem in this phase has a first-class solution in the existing toolchain. The work is configuration, not implementation.

---

## Common Pitfalls

### Pitfall 1: DATABASE_URL Not Overridden Before App Boots

**What goes wrong:** `vitest.setup.ts` runs but `DATABASE_URL` in `process.env` is already loaded by `config.ts` (which calls `dotenvConfig()` at module import time). If `setup.ts` imports `buildApp` before the env override runs, the app connects to the dev DB.

**Why it happens:** Module evaluation order. `config.ts` calls `dotenvConfig()` at the top level, so it runs when the module is first imported.

**How to avoid:** The Vitest `globalSetup` file must set `process.env.DATABASE_URL` BEFORE any test file imports the app. `globalSetup` runs in a separate module context before the test workers. If using `setupFiles` instead, ensure the override file is listed first in the array. The safest approach is a `globalSetup` that sets the env var unconditionally before any test file is imported.

**Warning signs:** Tests write to the dev database (check row count or check which schema queries hit).

### Pitfall 2: `prisma db push` Not Run Against Test Schema

**What goes wrong:** `?schema=test` creates a new PostgreSQL schema. If `prisma db push` has not been run with `TEST_DATABASE_URL`, the schema has no tables and all tests fail with "relation does not exist."

**Why it happens:** The test schema is not auto-created by connecting to it. It requires an explicit schema push.

**How to avoid:** Add a `pretest` npm script in `apps/api/package.json`:

```json
"pretest": "TEST_DATABASE_URL=$TEST_DATABASE_URL pnpm --filter @clokr/db exec prisma db push --skip-generate"
```

Or document the one-time setup step prominently in the PR description.

**Warning signs:** First test run fails with "relation does not exist" on every table.

### Pitfall 3: `parserOptions.project` Causes Slow Lint on Svelte Files

**What goes wrong:** Adding `parserOptions.project: true` globally (including Svelte files) causes typescript-eslint to run type checking on `.svelte` files, which is very slow and may error.

**Why it happens:** `.svelte` files require the `svelte-eslint-parser` which has separate TypeScript handling. The `project` option applied to Svelte files conflicts.

**How to avoid:** Scope the `parserOptions.project` configuration to `files: ["**/*.ts"]` only, not globally. The existing Svelte block in `eslint.config.js` already has `languageOptions.parser: svelteParser` — do not add `project` to it.

**Warning signs:** `eslint --ext .svelte` is dramatically slow (>30s), or errors like "Parsing error: ESLint was configured to run on `<tsconfigRootDir>/**/*.svelte` however that pattern does not match".

### Pitfall 4: coverage.thresholds Set Too High Immediately

**What goes wrong:** The baseline measurement step is skipped and thresholds are set at aspirational levels (e.g., 80%). CI fails on the first PR, and the team perceives coverage enforcement as hostile.

**Why it happens:** It is tempting to set targets that reflect the desired end state.

**How to avoid:** Per D-04: run `pnpm --filter @clokr/api test:coverage` first, record the actual percentages, subtract 3-5 points, and set those as thresholds. This creates a ratchet: thresholds only go up, never start above actual.

**Warning signs:** CI fails immediately after enabling thresholds on a PR that adds no new code.

### Pitfall 5: Docker Seed Fails Silently After Fix Attempt

**What goes wrong:** The `|| true` is removed but the seed script imports `../generated/client` — a path relative to `packages/db/src/seed.ts`. When compiled with a standalone `tsc` command (not inside the package's module context), the relative import resolves incorrectly and compilation fails with "Cannot find module '../generated/client'".

**Why it happens:** The `generated/client` directory exists at `packages/db/generated/client` but when `tsc` is invoked from `/app` with `packages/db/src/seed.ts` as input, the output path and module resolution may differ from what the seed script expects.

**How to avoid:** Compile using `pnpm --filter @clokr/db run seed:build` (a script that runs from within the package context) rather than a direct `npx tsc` invocation from the repo root.

**Warning signs:** Build stage fails with "Cannot find module" or "Property 'PrismaClient' does not exist".

---

## Code Examples

### vitest.config.ts with globalSetup and coverage thresholds

```typescript
// apps/api/vitest.config.ts
import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    globals: true,
    environment: "node",
    root: "./src",
    include: ["**/*.test.ts"],
    fileParallelism: false,
    testTimeout: 30000,
    globalSetup: ["../vitest.setup.ts"], // relative to root: ./src
    coverage: {
      provider: "v8",
      include: ["**/*.ts"],
      exclude: ["**/*.test.ts", "**/index.ts"],
      thresholds: {
        lines: 65, // set from baseline measurement
        functions: 65, // set from baseline measurement
        branches: 55, // set from baseline measurement
      },
    },
  },
});
```

Note: `globalSetup` paths are relative to the vitest config file (not `root`). Adjust path accordingly.

### vitest.setup.ts (global setup)

```typescript
// apps/api/vitest.setup.ts
export async function setup() {
  // Must run before any test file imports the app
  if (process.env.TEST_DATABASE_URL) {
    process.env.DATABASE_URL = process.env.TEST_DATABASE_URL;
  } else {
    throw new Error(
      "TEST_DATABASE_URL is not set. Run: export TEST_DATABASE_URL=postgresql://clokr:password@localhost:5432/clokr?schema=test",
    );
  }
}
```

### ESLint flat config with no-floating-promises

```javascript
// eslint.config.js — add this block (after existing tseslint.configs.recommended spread)
{
  files: ["apps/api/src/**/*.ts"],
  languageOptions: {
    parserOptions: {
      project: true,
      tsconfigRootDir: import.meta.dirname,
    },
  },
  rules: {
    "@typescript-eslint/no-floating-promises": "error",
    "@typescript-eslint/no-misused-promises": "error",
  },
},
```

### Replacing .catch(() => {}) — correct pattern

```typescript
// Before (4 locations — auth.ts:42, overtime.ts:36, time-entries.ts:200, terminals.ts:110)
someOperation().catch(() => {});

// After — use app.log.error with structured context
someOperation().catch((err) =>
  app.log.error({ err }, "Non-critical DB write failed: lastUsedAt update"),
);

// For fire-and-forget that still must not block:
void someOperation().catch((err) =>
  app.log.error({ err }, "Overtime account recalculation failed silently"),
);
```

Note: `void` operator explicitly marks the promise as intentionally unhandled, satisfying `no-floating-promises`. The `.catch` logger runs on failure. This is the idiomatic pattern when fire-and-forget is intentional but failure must be visible.

### Playwright auth.setup.ts

```typescript
// apps/e2e/tests/auth.setup.ts
import { test as setup, expect } from "@playwright/test";

const ADMIN_FILE = ".auth/admin.json";

setup("authenticate as admin", async ({ page }) => {
  await page.goto("/login");
  await page.getByLabel("E-Mail").fill(process.env.TEST_ADMIN_EMAIL || "admin@clokr.de");
  await page
    .getByLabel("Passwort", { exact: true })
    .fill(process.env.TEST_ADMIN_PASSWORD || "Admin123!Pass");
  await page.getByRole("button", { name: /anmelden/i }).click();
  await page.waitForURL("**/dashboard", { timeout: 10_000 });
  await expect(page).toHaveURL(/dashboard/);
  await page.context().storageState({ path: ADMIN_FILE });
});
```

### packages/db/tsconfig.seed.json (new file)

```json
{
  "compilerOptions": {
    "outDir": "dist",
    "module": "commonjs",
    "moduleResolution": "node",
    "esModuleInterop": true,
    "target": "es2020",
    "skipLibCheck": true,
    "resolveJsonModule": true
  },
  "include": ["src/seed.ts"],
  "exclude": ["node_modules", "generated"]
}
```

### packages/db/package.json seed:build addition

```json
"scripts": {
  "generate": "prisma generate",
  "migrate": "prisma migrate dev",
  "migrate:deploy": "prisma migrate deploy",
  "studio": "prisma studio",
  "seed": "tsx src/seed.ts",
  "seed:build": "tsc --project tsconfig.seed.json"
}
```

### Dockerfile fix (remove suppression)

```dockerfile
# Before
RUN mkdir -p packages/db/dist && \
    npx tsc packages/db/src/seed.ts --outDir packages/db/dist --esModuleInterop --module commonjs --target es2020 --skipLibCheck 2>/dev/null || true

# After
RUN pnpm --filter @clokr/db run seed:build
```

---

## State of the Art

| Old Approach                       | Current Approach                             | When Changed          | Impact                                          |
| ---------------------------------- | -------------------------------------------- | --------------------- | ----------------------------------------------- |
| Per-test login in Playwright       | `storageState` setup project                 | Playwright v1.20+     | 60-80% faster E2E runs                          |
| Manual coverage threshold checking | `vitest coverage.thresholds` with exit code  | Vitest v1.0+          | CI blocks on regression automatically           |
| TypeScript-unaware ESLint rules    | Type-aware rules via `parserOptions.project` | typescript-eslint v6+ | Rules like `no-floating-promises` actually work |
| `istanbul` coverage                | V8 native coverage                           | Vitest v0.25+         | No Babel transform; faster; already configured  |

**Deprecated/outdated:**

- `@vitest/coverage-istanbul`: The project already uses `v8` — do not switch.
- `eslint-plugin-@typescript-eslint` (legacy): The project already uses `typescript-eslint` (unified package) — correct, no change needed.

---

## Open Questions

1. **Prisma 7 `?schema=` URL parameter — confirmed for PrismaPg adapter?**
   - What we know: `?schema=NAME` is a standard PostgreSQL connection string feature and Prisma documents it for schema isolation. The project uses `PrismaPg` (the new adapter-based driver).
   - What's unclear: Whether `PrismaPg` passes the schema URL parameter through to the underlying `pg.Pool` correctly, or whether the schema must be set via `search_path` separately.
   - Recommendation: Verify by running `prisma db push` with `?schema=test` appended and checking that a `test` schema is created in PostgreSQL. If not, use `options=-csearch_path%3Dtest` in the URL instead.

2. **Vitest globalSetup vs setupFiles for DATABASE_URL override**
   - What we know: `globalSetup` runs in the Node.js main process before workers; `setupFiles` run in each worker. For an env var that must be set before module evaluation, `globalSetup` is more reliable.
   - What's unclear: Whether `config.ts` is evaluated lazily (on first import) or eagerly at startup in test context.
   - Recommendation: Use `globalSetup`. If DATABASE_URL is still wrong at test time, add a `process.env.DATABASE_URL` assertion at the top of `setup.ts` as a guard.

3. **Can `fileParallelism: true` be enabled after test schema isolation?**
   - What we know: The CONTEXT notes this as a v2 requirement (PERF-02). The per-tenant unique suffix approach theoretically supports parallelism once the test schema is isolated.
   - What's unclear: Whether the shared `app` singleton in `setup.ts` (single Fastify instance) is safe with parallel workers.
   - Recommendation: Keep `fileParallelism: false` for this phase. Enabling parallelism is PERF-02 scope.

---

## Environment Availability

| Dependency          | Required By           | Available      | Version            | Fallback |
| ------------------- | --------------------- | -------------- | ------------------ | -------- |
| PostgreSQL          | TEST-01 (test schema) | ✓ (via Docker) | 18-alpine          | —        |
| Node.js             | All                   | ✓              | 24-alpine (Docker) | —        |
| pnpm                | All                   | ✓              | 10.33.0            | —        |
| vitest              | TEST-01, TEST-03      | ✓              | ^4.1.2             | —        |
| @vitest/coverage-v8 | TEST-03               | ✓              | ^4.1.1             | —        |
| @playwright/test    | TEST-02               | ✓              | ^1.58.2            | —        |
| typescript-eslint   | TEST-04               | ✓              | ^8.57.2            | —        |
| Prisma CLI          | TEST-01 (db push)     | ✓              | ^7.6.0             | —        |

**Missing dependencies with no fallback:** None.

**Notes:** All dependencies are already installed. This phase requires zero `pnpm install` changes. The only infrastructure dependency is that the Docker PostgreSQL container is running locally when the `pretest` schema push runs.

---

## Validation Architecture

### Test Framework

| Property           | Value                                    |
| ------------------ | ---------------------------------------- |
| Framework          | Vitest 4.1.x + @vitest/coverage-v8       |
| Config file        | `apps/api/vitest.config.ts`              |
| Quick run command  | `pnpm --filter @clokr/api test`          |
| Full suite command | `pnpm --filter @clokr/api test:coverage` |

### Phase Requirements → Test Map

| Req ID   | Behavior                                                                  | Test Type           | Automated Command                                                   | File Exists?                            |
| -------- | ------------------------------------------------------------------------- | ------------------- | ------------------------------------------------------------------- | --------------------------------------- |
| TEST-01  | No rows written to dev DB after test run                                  | integration smoke   | `pnpm --filter @clokr/api test` (verify dev DB row count unchanged) | ❌ Wave 0 — add assertion               |
| TEST-02  | E2E tests skip login page (use storageState)                              | E2E                 | `pnpm --filter e2e test`                                            | ❌ Wave 0 — auth.setup.ts               |
| TEST-03  | Coverage below threshold fails `pnpm test:coverage`                       | automated threshold | `pnpm --filter @clokr/api test:coverage`                            | ❌ Wave 0 — add thresholds config       |
| TEST-04  | `.catch(() => {})` causes `pnpm lint` to fail with error                  | lint                | `pnpm lint`                                                         | ❌ Wave 0 — enable rule + fix instances |
| AUDIT-01 | All 4 `.catch(() => {})` replaced; no new silent catches                  | lint                | `pnpm lint` (no-floating-promises error blocks)                     | ❌ Wave 0 — replace instances           |
| AUDIT-03 | Docker build completes with seed; `SEED_DEMO_DATA=true` seeds demo tenant | Docker build smoke  | `docker compose up --build -d` (check logs)                         | ❌ Wave 0 — manual Docker build test    |

### Sampling Rate

- **Per task commit:** `pnpm --filter @clokr/api test` (unit + integration, no coverage)
- **Per wave merge:** `pnpm --filter @clokr/api test:coverage && pnpm lint`
- **Phase gate:** Full suite green + lint clean + Docker build succeeds before `/gsd:verify-work`

### Wave 0 Gaps

- [ ] `apps/api/vitest.setup.ts` — global setup that sets `DATABASE_URL = TEST_DATABASE_URL`
- [ ] `apps/api/.env.test` — contains `TEST_DATABASE_URL` pointing to `?schema=test`
- [ ] `apps/e2e/tests/auth.setup.ts` — Playwright setup project for storageState
- [ ] `apps/e2e/.auth/` — gitignored directory for storageState JSON
- [ ] `packages/db/tsconfig.seed.json` — dedicated tsconfig for seed compilation

---

## Project Constraints (from CLAUDE.md)

The following CLAUDE.md directives are directly relevant to this phase:

| Directive                                         | Impact on Phase                                                                                                                                                                                 |
| ------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Docker-only dev** (MEMORY.md)                   | All test runs must work via `docker compose` stack; `pretest` schema push must account for Docker PG endpoint                                                                                   |
| **Always use branches** (MEMORY.md)               | Every change in this phase goes on a branch + PR, not direct to main                                                                                                                            |
| **Audit-proof / Revisionssicherheit**             | Test cleanup MUST use hard deletes (`prisma.*.deleteMany`) — the existing `cleanupTestData` is correct. Do NOT add `deletedAt` filters to cleanup; test data is not subject to retention rules. |
| **No hard deletes on time entries etc.**          | Only applies to production code paths. Test cleanup explicitly deletes test records — this is intentional and correct (test records are not real data).                                         |
| **pnpm workspaces**                               | All scripts must use `pnpm --filter <package>` form; no direct `npm` or `cd apps/api && pnpm`                                                                                                   |
| **`pnpm --filter @clokr/db exec prisma db push`** | Documented pattern for schema sync; use this exact form for test schema push                                                                                                                    |
| **Code in English, UI in German**                 | vitest.setup.ts, auth.setup.ts, and all new config files: English code + comments                                                                                                               |
| **No `pnpm dev` locally**                         | Dev stack runs via Docker; tests connect to Dockerized PG                                                                                                                                       |

---

## Sources

### Primary (HIGH confidence)

- `apps/api/src/__tests__/setup.ts` — existing test infrastructure analyzed in full
- `apps/api/vitest.config.ts` — current config (no thresholds, no globalSetup)
- `apps/e2e/playwright.config.ts` — current config (no setup project, no storageState)
- `eslint.config.js` — confirmed: no `parserOptions.project`, no `no-floating-promises`
- `apps/api/Dockerfile` — confirmed `2>/dev/null || true` on line 33
- `apps/api/docker-entrypoint.sh` — confirmed tsx fallback with suppression
- `apps/api/src/plugins/prisma.ts` — confirmed `process.env.DATABASE_URL` used directly (no test override)
- `apps/api/src/config.ts` — confirmed `dotenvConfig()` called at module load time
- `packages/db/src/seed.ts` — confirmed `../generated/client` relative import and `PrismaPg` usage
- `packages/db/package.json` — confirmed `tsx src/seed.ts` as seed script; no `seed:build`
- `.planning/research/ARCHITECTURE.md` — prior research on test DB isolation and storageState patterns
- `.planning/codebase/CONCERNS.md` — confirmed 4 `.catch(() => {})` locations
- Grep audit: `\.catch\(\(\) => \{\}\)` — confirmed exactly 4 matches in `apps/api/src`

### Secondary (MEDIUM confidence)

- Playwright documentation pattern for storageState setup projects — widely documented, `dependencies` array is v1.20+ API
- typescript-eslint `parserOptions.project: true` requirement for type-aware rules — documented in typescript-eslint v6+ migration guide

### Tertiary (LOW confidence)

- Prisma 7 `?schema=` URL parameter behavior with `PrismaPg` adapter — documented for `prisma-client-js` generally; PrismaPg passthrough not independently verified. Recommend verifying with a `db push` test.

---

## Metadata

**Confidence breakdown:**

- Standard stack: HIGH — all packages already installed, versions confirmed from package.json files
- Architecture: HIGH — patterns derived from reading actual source code, not assumptions
- Pitfalls: HIGH — all pitfalls derived from actual code analysis (CONCERNS.md, Dockerfile audit, ESLint config audit)
- Docker seed fix: MEDIUM — root cause confirmed; fix pattern is standard but exact tsconfig paths need verification during implementation

**Research date:** 2026-03-30
**Valid until:** 2026-04-30 (stable domain — Vitest, Playwright, ESLint versions are pinned in package.json)

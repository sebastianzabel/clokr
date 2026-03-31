# Architecture Patterns: Test Architecture, Audit, and UI Quality

**Domain:** Production hardening — Fastify + SvelteKit + Prisma monorepo
**Researched:** 2026-03-30
**Confidence:** HIGH (grounded in actual codebase state + verified against official docs)

---

## Recommended Architecture

The production-readiness work spans three independent-but-connected subsystems, each with its own component
structure, data flow, and build order. The key architectural insight is that these three subsystems
(testing, audit/compliance, UI quality) share no runtime dependencies but do share the same boundary:
they all operate against the existing app components without modifying their behavior.

```
┌─────────────────────────────────────────────────────────────────┐
│                    PRODUCTION HARDENING LAYER                   │
│                                                                 │
│  ┌────────────────┐  ┌──────────────────┐  ┌───────────────┐   │
│  │  TEST SUITE    │  │  CODE AUDIT      │  │  UI QUALITY   │   │
│  │  SUBSYSTEM     │  │  SUBSYSTEM       │  │  SUBSYSTEM    │   │
│  └────────┬───────┘  └────────┬─────────┘  └──────┬────────┘   │
└───────────┼────────────────────┼───────────────────┼───────────┘
            │                    │                   │
     ┌──────▼──────┐      ┌──────▼──────┐    ┌──────▼──────┐
     │  apps/api   │      │  apps/api   │    │  apps/web   │
     │  apps/web   │      │  packages/db│    │  apps/e2e   │
     │  packages/db│      │  (schema)   │    │             │
     └─────────────┘      └─────────────┘    └─────────────┘
```

---

## Subsystem 1: Test Suite Architecture

### Current State (from codebase analysis)

The existing test setup has one critical structural problem: **tests share the dev database**.

```
apps/api/src/__tests__/setup.ts (line 6):
  "Uses the same database as dev (TODO: separate test DB for CI)."
```

The current model:

- Single shared PostgreSQL instance (dev DB = test DB in local dev)
- `fileParallelism: false` forces sequential execution as a workaround
- Each suite creates a uniquely-suffixed tenant and cleans up via `cleanupTestData()`
- `closeTestApp()` is a deliberate no-op — the singleton is never torn down

This works but imposes a global sequential lock across all 23 test files.

### Component Boundaries

| Component                                 | Responsibility                                                                   | Communicates With        |
| ----------------------------------------- | -------------------------------------------------------------------------------- | ------------------------ |
| `apps/api/src/__tests__/setup.ts`         | Singleton `buildApp()`, `seedTestData()`, `cleanupTestData()`                    | Fastify app, Prisma      |
| `apps/api/src/__tests__/*.test.ts`        | Domain integration tests (auth, employees, leave, time-entries, overtime, saldo) | setup.ts, Fastify inject |
| `apps/api/src/routes/__tests__/*.test.ts` | Route-specific tests (arbzg, breaks, minijob, nfc, reports)                      | setup.ts, Fastify inject |
| `apps/api/src/utils/__tests__/*.test.ts`  | Pure unit tests for utility functions                                            | No external deps         |
| `apps/e2e/tests/*.spec.ts`                | Browser E2E tests covering critical user flows                                   | Running Docker stack     |
| `apps/e2e/tests/helpers.ts`               | Shared login/logout helpers, TEST_ADMIN credentials                              | Playwright Page          |

### Data Flow: API Test Request

```
Test file
  → app.inject({ method, url, headers, payload })   [Fastify light-my-request, no socket]
    → requireAuth middleware                          [validates JWT from seedTestData login]
      → route handler                                [runs business logic]
        → app.prisma.*                               [real Prisma queries on test DB]
          → app.audit()                              [real audit entries written]
        → response                                   [returned via inject, not HTTP]
  ← res.statusCode, JSON.parse(res.body)
```

### Recommended Isolation Architecture

The current tenant-per-suite approach is correct and should be preserved. The key improvement
is moving the test database to a separate PostgreSQL schema or CI-only DB instance.

**Option A: Separate TEST_DATABASE_URL (recommended)**

Add `TEST_DATABASE_URL` to CI environment pointing to a separate DB (`clokr_test`).
The Vitest config reads `process.env.TEST_DATABASE_URL` when `NODE_ENV=test`.
This is zero-dependency, fully compatible with the existing singleton pattern.

```
CI: DATABASE_URL=postgresql://.../clokr        → used by app in production
    TEST_DATABASE_URL=postgresql://.../clokr_test → used by vitest only
```

**Option B: Transaction rollback isolation (future)**

`vitest-environment-prisma-postgres` wraps each test in a PostgreSQL transaction and rolls
it back after completion. This enables parallel execution (`fileParallelism: true`) and
eliminates cleanup code. However, it requires mocking `app.prisma` globally and conflicts
with the existing Fastify singleton + `app.inject()` pattern. Not recommended for this milestone —
the current per-tenant isolation is simpler and already working.

### Recommended E2E Architecture

Current E2E state: `fullyParallel: false, workers: 1`, login in every `beforeEach`.

The correct pattern for this application is **Playwright storageState with a setup project**:

```
playwright.config.ts
  projects:
    - name: "setup"          → runs auth.setup.ts once before all projects
      testMatch: /auth.setup.ts/
    - name: "desktop-chrome"
      dependencies: ["setup"]
      use: { storageState: ".auth/admin.json" }
    - name: "mobile-chrome"
      dependencies: ["setup"]
      use: { storageState: ".auth/admin.json" }
    - name: "tablet"
      dependencies: ["setup"]
      use: { storageState: ".auth/admin.json" }
```

The setup project runs `loginAsAdmin()` once, saves `page.context().storageState()` to
`.auth/admin.json`, and all subsequent test files skip the login page entirely.
Measured speedup in comparable apps: 60-80% reduction in E2E run time.

For multi-role tests (admin vs. employee flows), maintain separate `.auth/employee.json`.

**Note:** `.auth/*.json` must be in `.gitignore` — contains JWT tokens.

### Test Coverage Thresholds

Currently no thresholds are enforced (`coverage.thresholds` absent from `vitest.config.ts`).
For production readiness, add minimum thresholds to fail CI on regression:

```typescript
// vitest.config.ts
coverage: {
  provider: "v8",
  thresholds: {
    lines: 70,
    functions: 70,
    branches: 60,
  }
}
```

**Do not set thresholds above actual current coverage** — measure first, then enforce.

### Build Order: Test Subsystem

```
1. Separate test DB setup (TEST_DATABASE_URL env var in CI)
2. storageState setup project for E2E (auth.setup.ts)
3. Coverage thresholds enforcement in vitest.config.ts
4. Missing test coverage for routes not yet tested
5. ArbZG edge case unit tests (boundary conditions per CLAUDE.md rules)
```

Dependencies: steps 1 and 2 are independent. Step 3 depends on knowing current coverage.
Steps 4 and 5 depend on the test infrastructure being solid.

---

## Subsystem 2: Code Audit Architecture

### Component Boundaries

| Component                         | Responsibility                                                                        | Communicates With              |
| --------------------------------- | ------------------------------------------------------------------------------------- | ------------------------------ |
| ESLint security ruleset           | Static analysis for injection patterns, `eval`, dangerous Node APIs                   | `apps/api/src/` TypeScript     |
| `npm audit` / Trivy               | Dependency CVE scan (already in CI, see `.trivyignore`)                               | `package.json` lock files      |
| Manual audit protocol             | Systematic review of compliance patterns (soft deletes, audit trail, isLocked checks) | Route handlers, Prisma queries |
| `apps/api/src/middleware/auth.ts` | Authorization boundary — `requireAuth` + `requireRole`                                | All route handlers             |

### Known Audit Findings (from codebase analysis)

Three categories of known tech debt require structured audit:

**Category 1: Fire-and-forget anti-pattern**

```typescript
// apps/api/src/middleware/auth.ts (line ~43)
req.server.prisma.apiKey
  .update({ where: { id: apiKey.id }, data: { lastUsedAt: new Date() } })
  .catch(() => {});
```

This silently swallows errors. `lastUsedAt` updates are non-critical so fire-and-forget is
acceptable here, but the same pattern applied to audit log writes or compliance-critical
updates would be a production defect. Audit task: enumerate all `.catch(() => {})` occurrences
and classify each as acceptable/unacceptable.

**Category 2: Soft delete query completeness**
CLAUDE.md mandates `deletedAt: null` on every query against `TimeEntry`, `LeaveRequest`, `Absence`.
Audit task: verify every `prisma.timeEntry.findMany/findFirst/findUnique` includes this filter.

**Category 3: isLocked gate completeness**
CLAUDE.md mandates: "Once a month is closed (isLocked), entries MUST NOT be editable or deletable."
Audit task: verify every UPDATE/DELETE route for `TimeEntry` checks `isLocked` before proceeding.

### Data Flow: Audit Trail Completeness Check

```
For each write route (POST, PUT, PATCH, DELETE):
  Route handler
    → business logic validation (locked check, soft delete check)
    → prisma mutation
    → app.audit({ userId, action, entity, entityId, oldValue, newValue, ip, userAgent })
      → AuditLog record created
```

Any route that performs a prisma mutation without a subsequent `app.audit()` call is a compliance gap.

### ESLint Security Configuration

The existing codebase has no ESLint config (`apps/api/.eslintrc*` not found).
`eslint-plugin-security` has 1.5M weekly downloads but only 13 rules and minimal maintenance
since 2020. For this codebase, a targeted ESLint config is more valuable than a general
security plugin:

```javascript
// apps/api/eslint.config.js
export default [
  {
    rules: {
      "no-eval": "error",
      "no-new-func": "error",
      "no-implied-eval": "error",
      // Require explicit error handling (catches fire-and-forget)
      "@typescript-eslint/no-floating-promises": "error",
    },
  },
];
```

`@typescript-eslint/no-floating-promises` is the highest-value rule for this codebase: it flags
every unhandled Promise (`.catch(() => {})`-style suppressions still compile but fire-and-forget
on non-`.catch()` paths would be caught). This rule is already available via `@typescript-eslint`.

**Use `npm audit --audit-level=high`** in CI for dependency CVEs. The existing Trivy scan in
`.github/workflows/build-push.yml` covers this at the Docker layer.

### DSGVO / Compliance Audit Dimensions

Based on CLAUDE.md requirements and OWASP guidance:

| Dimension                | Check                                                                        | Risk if Missing             |
| ------------------------ | ---------------------------------------------------------------------------- | --------------------------- |
| Soft delete coverage     | All `TimeEntry`, `LeaveRequest`, `Absence` queries include `deletedAt: null` | Silent data exposure        |
| Audit trail completeness | All write operations call `app.audit()`                                      | Revisionssicherheit failure |
| isLocked enforcement     | All UPDATE/DELETE on TimeEntry check `monthClosure.isLocked`                 | Legal liability             |
| Tenant isolation         | All employee-scoped queries include `tenantId` from JWT                      | Cross-tenant data leak      |
| JWT expiry handling      | Refresh token rotation, access token 15min TTL                               | Session hijacking           |
| Rate limiting scope      | `@fastify/rate-limit` covers auth endpoints specifically                     | Brute force                 |
| Input validation         | Every route has Zod schema, no raw `req.body` access                         | Injection                   |
| DSGVO anonymization      | Employee deletion calls anonymization, not hard delete                       | Art. 17 violation           |

### Build Order: Audit Subsystem

```
1. Add ESLint config with @typescript-eslint/no-floating-promises
2. Run lint, enumerate all .catch(() => {}) and unhandled promises
3. Grep for all TimeEntry/LeaveRequest/Absence queries, verify deletedAt: null
4. Grep for all write routes, verify app.audit() present
5. Grep for all TimeEntry UPDATE/DELETE routes, verify isLocked check
6. Grep for all employee-scoped queries, verify tenantId filter
7. Review auth middleware for edge cases (API key expiry, terminal keys)
```

These steps are sequential (each grep depends on knowing what to look for) but independently
actionable — different developers can own different dimensions.

---

## Subsystem 3: UI Quality Architecture

### Component Boundaries

| Component                              | Responsibility                              | Communicates With    |
| -------------------------------------- | ------------------------------------------- | -------------------- |
| `apps/e2e/tests/mobile-flow.spec.ts`   | Mobile viewport responsive checks (Pixel 7) | Running Docker stack |
| `apps/e2e/tests/ui-audit.spec.ts`      | Systematic UI consistency checks            | Running Docker stack |
| `apps/e2e/tests/ui-quality.spec.ts`    | Component-level quality checks              | Running Docker stack |
| `apps/e2e/tests/accessibility.spec.ts` | `@axe-core/playwright` a11y audit           | Running Docker stack |
| `apps/e2e/tests/visual-audit.spec.ts`  | Visual regression audit                     | Running Docker stack |
| `apps/web/src/lib/`                    | Shared components, API client, stores       | No direct test dep   |

### Data Flow: E2E UI Test

```
Playwright test
  → page.goto("/dashboard")
    → SvelteKit hooks.server.ts                    [proxies /api/* to Fastify]
      → browser renders Svelte 5 components
        → onMount: api.get('/dashboard')            [real API call through proxy]
          → Fastify route handler                   [real DB query]
    → page.getByRole() / page.getByLabel()          [semantic locators, German text]
      → assertion
```

All E2E tests depend on a **running Docker Compose stack**. This is an external dependency
that CI would need as a separate job (currently E2E is not in CI).

### Svelte 5 Component Testing

No component tests exist in `apps/web/src/`. For production readiness, the recommended approach
is `vitest-browser-svelte` (official Svelte 5 support, uses Playwright as browser provider):

```typescript
// apps/web/vitest.config.ts
import { defineConfig } from "vitest/config";
import { svelte } from "@sveltejs/vite-plugin-svelte";

export default defineConfig({
  plugins: [svelte()],
  test: {
    browser: {
      enabled: true,
      provider: "playwright",
      name: "chromium",
    },
  },
});
```

However, for this production-readiness milestone, component tests are lower priority than
E2E coverage. The recommendation is to add component tests as a **future milestone** rather
than this one — the ROI is in verifying user flows, not individual components.

### UI Quality Dimensions

| Dimension             | How to Test                                              | Tool                               |
| --------------------- | -------------------------------------------------------- | ---------------------------------- |
| Mobile responsiveness | Pixel 7 viewport, check layout does not overflow         | Playwright `mobile-chrome` project |
| Color contrast        | axe-core rules `color-contrast`                          | `@axe-core/playwright`             |
| Navigation flow       | Verify each main page loads without errors               | Playwright `core-flows.spec.ts`    |
| Form feedback         | Submit invalid data, verify German error messages appear | Playwright assertions              |
| Loading states        | Verify skeleton loaders render before data               | Playwright `waitForSelector`       |
| Touch targets         | axe-core `target-size` rule                              | `@axe-core/playwright`             |

### Build Order: UI Quality Subsystem

```
1. Fix E2E storageState (auth.setup.ts) — prerequisite for all E2E work
2. Mobile viewport audit — enumerate layout issues with screenshots
3. a11y audit run — generate axe-core report, triage violations
4. Critical flow coverage — leave flow, time entry flow fully covered
5. Consistency pass — spacing, colors, component usage uniformity
```

Step 1 is a prerequisite. Steps 2-4 are independent. Step 5 depends on steps 2-4 being done
(cannot audit consistency until responsiveness and a11y are fixed).

---

## Cross-Cutting Architectural Concerns

### The Docker Dependency Problem

API tests use `buildApp()` + `app.inject()` — they do **not** require Docker or a live server.
E2E tests require the full Docker Compose stack (`web` + `api` + `postgres`).

This creates two distinct CI requirements:

```
CI Job A: api-tests
  Requires: PostgreSQL service container only
  Command: pnpm --filter @clokr/api test
  Currently: implemented in .github/workflows/ci.yml

CI Job B: e2e-tests  [NOT YET IN CI]
  Requires: docker compose up (full stack)
  Command: cd apps/e2e && pnpm test
  Currently: manual only
```

E2E in CI would require either:

- `docker compose up --build -d` in the CI job, then `pnpm test`, then `docker compose down`
- Or a dedicated e2e CI workflow that uses Docker Compose service definitions

This is an infrastructure concern (out of scope per PROJECT.md) but the E2E
architecture must be designed around this constraint.

### Shared Test DB vs. Separate Test DB

The existing `TODO` in `setup.ts` ("separate test DB for CI") is the highest-priority
structural fix. The current workaround (`fileParallelism: false`) enforces sequential
execution across all 23 test files, making the entire suite slower than necessary.

A separate test DB eliminates the risk of a test pollution leaking into developer data
during local development — a real risk when the dev DB and test DB are the same.

### Compliance Testing as Regression Guard

CLAUDE.md's audit requirements (soft deletes, audit trail, isLocked) should be expressed
as test assertions, not just documentation. Recommended approach: add a dedicated
`apps/api/src/__tests__/compliance.test.ts` that asserts:

1. Hard deleting a TimeEntry returns an error (Prisma should reject due to `onDelete: Restrict`)
2. Creating a TimeEntry in a locked month returns 423 or equivalent error
3. The AuditLog table has an entry after every create/update/delete test

These tests serve as regression guards: if a future developer inadvertently removes an
isLocked check, the compliance test catches it before it reaches production.

---

## Build Order: Full Hardening Roadmap Implications

The dependency graph between all three subsystems suggests this phase ordering:

```
Phase 1: Test Infrastructure Hardening
  - Separate TEST_DATABASE_URL (unblocks reliable isolated testing)
  - storageState setup project for E2E (unblocks fast E2E iteration)
  - Coverage threshold enforcement (establishes baseline)
  Rationale: Everything else depends on having reliable, fast tests.

Phase 2: API Test Coverage + Audit
  - Missing route coverage (routes not yet in __tests__)
  - ArbZG boundary condition tests
  - ESLint @typescript-eslint/no-floating-promises, fix violations
  - Compliance audit (soft deletes, audit trail, isLocked)
  Rationale: Code is only auditable when it's testable.

Phase 3: UI/UX Quality
  - Mobile responsiveness pass
  - a11y audit and triage
  - Critical flow E2E coverage
  - Design consistency pass
  Rationale: UI quality work requires E2E infrastructure from Phase 1.
```

Phases 2 and 3 can run in parallel if different team members own API vs. UI tracks.
Phase 1 must complete first.

---

## Anti-Patterns to Avoid

### Anti-Pattern 1: E2E Login in Every beforeEach

**What:** `loginAsAdmin(page)` in `test.beforeEach` in every spec file.
**Why bad:** Login adds 1-3s per test. With 14+ spec files, each with multiple tests, this
compounds to minutes of pure authentication overhead.
**Instead:** Playwright `storageState` setup project — authenticate once, reuse the state.

### Anti-Pattern 2: Shared Dev + Test DB

**What:** Tests write to the same PostgreSQL database used for development.
**Why bad:** Test data pollution in dev, dev data pollution in tests. Irreproducible failures
when dev data violates test assumptions.
**Instead:** `TEST_DATABASE_URL` env var pointing to `clokr_test` database.

### Anti-Pattern 3: cleanupTestData as Safety Net

**What:** Relying on `afterAll` cleanup to prevent test pollution.
**Why bad:** If a test crashes before `afterAll`, orphaned test tenants accumulate in the DB.
After N runs, the dev DB has dozens of `Test Tenant te-xxx` rows.
**Instead:** Cleanup is fine as a secondary measure. Primary isolation should be at the DB level
(separate DB or schema per test run). As a tertiary measure, add a `beforeAll` cleanup that
deletes any leftover tenants matching the test prefix before seeding.

### Anti-Pattern 4: Compliance Rules Only in Documentation

**What:** CLAUDE.md documents "must check isLocked before UPDATE/DELETE" but no test enforces it.
**Why bad:** Documentation rot — a developer removing the check gets no CI signal.
**Instead:** Encode every compliance rule as an assertion in `compliance.test.ts`.

### Anti-Pattern 5: E2E Assertions on CSS Classes

**What:** `page.locator(".modal-content > .btn-primary")`.
**Why bad:** CSS class names change with UI refactors, breaking tests unrelated to behavior.
**Instead:** Role-based and label-based locators: `page.getByRole("button", { name: /speichern/i })`.
The existing `helpers.ts` already follows this — maintain it consistently.

---

## Scalability Considerations

These apply to the test architecture, not the application:

| Concern             | At current scale (23 test files)   | At 50+ test files                                 |
| ------------------- | ---------------------------------- | ------------------------------------------------- |
| Test execution time | ~2-3 min sequential                | ~5-10 min sequential (unacceptable)               |
| Mitigation          | `fileParallelism: false` works     | Needs separate test DB + parallel execution       |
| E2E execution time  | Workers: 1, sequential             | Would need parallel workers + separate test users |
| DB cleanup          | Manual `cleanupTestData` per suite | CI-only DB reset between runs is cleaner          |

---

## Sources

- Codebase: `/Users/sebastianzabel/git/clokr/apps/api/src/__tests__/setup.ts` (actual implementation)
- Codebase: `/Users/sebastianzabel/git/clokr/apps/e2e/playwright.config.ts` (actual E2E config)
- Codebase: `/Users/sebastianzabel/git/clokr/.github/workflows/ci.yml` (actual CI pipeline)
- [vitest-environment-prisma-postgres](https://github.com/codepunkt/vitest-environment-prisma-postgres) — transaction rollback isolation for Prisma + Vitest (MEDIUM confidence)
- [Blazing fast Prisma and Postgres tests in Vitest](https://codepunkt.de/writing/blazing-fast-prisma-and-postgres-tests-in-vitest/) — detailed explanation of the transaction rollback pattern (MEDIUM confidence)
- [Playwright Authentication Docs](https://playwright.dev/docs/auth) — storageState and setup project pattern (HIGH confidence, official)
- [Vitest Coverage Config](https://vitest.dev/config/coverage) — threshold configuration reference (HIGH confidence, official)
- [Vitest fileParallelism](https://vitest.dev/config/fileparallelism) — sequential execution config (HIGH confidence, official)
- [Fastify Testing Guide](https://fastify.dev/docs/v5.3.x/Guides/Testing/) — inject() pattern (HIGH confidence, official)
- [OWASP Node.js Security Cheat Sheet](https://cheatsheetseries.owasp.org/cheatsheets/Nodejs_Security_Cheat_Sheet.html) — audit checklist (HIGH confidence, official)
- [vitest-browser-svelte](https://github.com/vitest-community/vitest-browser-svelte) — Svelte 5 component testing (MEDIUM confidence)
- [@fastify/helmet GitHub](https://github.com/fastify/fastify-helmet) — security headers reference (HIGH confidence, official)

---

_Architecture analysis: 2026-03-30_

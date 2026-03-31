# Testing Patterns

**Analysis Date:** 2026-03-30

## Test Framework

**API Unit/Integration Tests:**

- **Runner:** Vitest v4.1+
- **Config:** `apps/api/vitest.config.ts`
- **Assertion Library:** Vitest built-in (`expect`)
- **Environment:** Node.js

**E2E Tests:**

- **Runner:** Playwright v1.58+
- **Config:** `apps/e2e/playwright.config.ts`
- **Accessibility:** `@axe-core/playwright` v4.11+

**Frontend Tests:**

- No unit/component tests for `apps/web` — no test files found in web src

**Run Commands:**

```bash
# API integration tests (all)
pnpm --filter @clokr/api test

# API tests in watch mode
pnpm --filter @clokr/api test:watch

# API tests with coverage
pnpm --filter @clokr/api test:coverage

# Run all tests via Turbo
pnpm test

# E2E tests (requires running app via Docker)
cd apps/e2e && pnpm test

# E2E - Chrome only
cd apps/e2e && pnpm test:chrome

# E2E - Mobile only
cd apps/e2e && pnpm test:mobile

# E2E - Accessibility audit only
cd apps/e2e && pnpm test:a11y
```

## Test File Organization

**API tests - Two locations:**

1. `apps/api/src/__tests__/*.test.ts` — Domain-level integration tests (auth, employees, leave, time-entries, overtime, etc.)
2. `apps/api/src/routes/__tests__/*.test.ts` — Route-specific integration tests (arbzg, breaks, minijob, nfc-punch, reports, etc.)
3. `apps/api/src/utils/__tests__/*.test.ts` — Pure unit tests for utility functions (holidays, timezone, vacation-calc)

**E2E tests:**

- `apps/e2e/tests/*.spec.ts` — Playwright specs (auth, core-flows, leave-flow, time-entries-flow, etc.)
- `apps/e2e/tests/helpers.ts` — Shared login/logout utilities

**Naming:**

- API tests: `{domain}.test.ts` — e.g., `auth.test.ts`, `time-entries.test.ts`, `arbzg.test.ts`
- E2E tests: `{domain}-flow.spec.ts` or `{domain}.spec.ts` — e.g., `auth.spec.ts`, `leave-flow.spec.ts`

**Full test file listing:**

```
apps/api/src/
├── __tests__/
│   ├── setup.ts                         # Shared test setup (app instance, seeding, cleanup)
│   ├── auth.test.ts                     # Authentication flow tests
│   ├── auto-break.test.ts               # Auto-break calculation tests
│   ├── employees.test.ts                # Employee CRUD tests
│   ├── imports.test.ts                  # Data import tests
│   ├── leave.test.ts                    # Leave/absence request tests
│   ├── leave-config.test.ts             # Leave configuration tests
│   ├── notifications.test.ts            # Notification system tests
│   ├── overtime-calc.test.ts            # Overtime saldo calculation tests
│   ├── password-policy.test.ts          # BSI password policy tests
│   ├── saldo-snapshot.test.ts           # Monatsabschluss/snapshot tests
│   ├── shifts.test.ts                   # Shift planning tests
│   └── time-entries.test.ts             # Time entry CRUD + clock-in/out tests
├── routes/__tests__/
│   ├── arbzg.test.ts                    # ArbZG compliance checks
│   ├── breaks.test.ts                   # Break slot management tests
│   ├── minijob.test.ts                  # MONTHLY_HOURS schedule tests
│   ├── nfc-punch.test.ts               # NFC terminal punch tests
│   ├── reports.test.ts                  # Report generation tests
│   ├── schedule-versioning.test.ts      # Work schedule version tests
│   ├── terminals.test.ts               # Terminal API key tests
│   └── time-entries-validation.test.ts  # Time entry validation rules
└── utils/__tests__/
    ├── holidays.test.ts                 # German public holiday calculation
    ├── timezone.test.ts                 # Timezone conversion utilities
    └── vacation-calc.test.ts            # Vacation entitlement calculation

apps/e2e/tests/
├── helpers.ts                           # Login/logout helpers
├── accessibility.spec.ts               # axe-core accessibility audit
├── admin-settings-flow.spec.ts         # Admin settings E2E
├── auth.spec.ts                        # Auth flow E2E
├── core-flows.spec.ts                  # Navigation smoke tests
├── dynamic-audit.spec.ts               # Audit log E2E
├── error-handling-flow.spec.ts         # Error state E2E
├── leave-flow.spec.ts                  # Leave request E2E
├── mobile-flow.spec.ts                 # Mobile responsive E2E
├── time-entries-flow.spec.ts           # Time entry E2E
├── ui-audit.spec.ts                    # UI quality audit
├── ui-quality.spec.ts                  # UI consistency checks
├── ux-design-audit.spec.ts             # UX design audit
├── ux-quality.spec.ts                  # UX quality checks
└── visual-audit.spec.ts               # Visual regression audit
```

## Vitest Configuration

```typescript
// apps/api/vitest.config.ts
export default defineConfig({
  test: {
    globals: true, // describe/it/expect available without import
    environment: "node",
    root: "./src",
    include: ["**/*.test.ts"],
    fileParallelism: false, // Sequential execution (shared DB)
    testTimeout: 30000, // 30s timeout per test
    coverage: {
      provider: "v8",
      include: ["**/*.ts"],
      exclude: ["**/*.test.ts", "**/index.ts"],
    },
  },
});
```

**Key setting:** `fileParallelism: false` — tests run sequentially because they share a real PostgreSQL database. Each test suite seeds and cleans up its own data.

## Test Structure

**Integration Test Pattern (API):**

```typescript
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { getTestApp, closeTestApp, seedTestData, cleanupTestData } from "./setup";
import type { FastifyInstance } from "fastify";

describe("Domain Name API", () => {
  let app: FastifyInstance;
  let data: Awaited<ReturnType<typeof seedTestData>>;

  beforeAll(async () => {
    app = await getTestApp();
    data = await seedTestData(app, "xx"); // 2-char unique suffix
  });

  afterAll(async () => {
    await cleanupTestData(app, data.tenant.id);
    await closeTestApp();
  });

  describe("POST /api/v1/resource", () => {
    it("creates a resource with valid data", async () => {
      const res = await app.inject({
        method: "POST",
        url: "/api/v1/resource",
        headers: { authorization: `Bearer ${data.adminToken}` },
        payload: {
          /* ... */
        },
      });

      expect(res.statusCode).toBe(201);
      const body = JSON.parse(res.body);
      expect(body.field).toBeDefined();
    });

    it("rejects invalid data", async () => {
      const res = await app.inject({
        /* ... */
      });
      expect(res.statusCode).toBe(400);
    });
  });
});
```

**Unit Test Pattern (Utilities):**

```typescript
import { describe, it, expect } from "vitest";
import { utilFunction } from "../util-file";

describe("utilFunction", () => {
  it("returns expected result for normal input", () => {
    expect(utilFunction(input)).toBe(expected);
  });

  it("handles edge case", () => {
    expect(utilFunction(edgeInput)).toBe(edgeExpected);
  });
});
```

## Test Setup & Seeding

**Shared setup at `apps/api/src/__tests__/setup.ts`:**

- `getTestApp()` — Singleton Fastify app instance (built once, reused across suites)
- `closeTestApp()` — Intentional no-op (singleton pattern)
- `seedTestData(app, suffix)` — Creates a complete test tenant with:
  - Tenant + TenantConfig
  - Admin user + employee (with WorkSchedule + OvertimeAccount)
  - Regular employee user + employee (with WorkSchedule + OvertimeAccount)
  - LeaveType (Urlaub/vacation) + LeaveEntitlement
  - JWT tokens for both admin and employee via actual login
- `cleanupTestData(app, tenantId)` — Deletes all data for a tenant in dependency order

**Suffix convention:** Each test file uses a unique 2-char suffix passed to `seedTestData` to prevent data collisions:

- `"te"` — time-entries, `"au"` — auth, `"lv"` — leave, `"ot"` — overtime
- `"az"` — arbzg, `"br"` — breaks, `"mj"` — minijob, `"sh"` — shifts
- `"pw"` — password-policy, `"snap"` — saldo-snapshot, `"nt"` — notifications

**Data isolation:** Tests use a real PostgreSQL database (same as dev). Each suite creates its own tenant and cleans up after. The suffix + timestamp combination ensures unique emails and employee numbers:

```typescript
const s =
  (suffix ? suffix + "-" : "") + Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
```

## Test Assertions

**HTTP API assertions:**

```typescript
// Status code checks
expect(res.statusCode).toBe(201);
expect(res.statusCode).toBe(400);
expect(res.statusCode).toBeLessThan(300);

// Body parsing (manual JSON.parse, not using .json())
const body = JSON.parse(res.body);
expect(body.entry).toBeDefined();
expect(body.entry.employeeId).toBe(data.employee.id);
expect(body.warnings.length).toBeGreaterThan(0);

// Array containment
expect(["PENDING", "APPROVED"]).toContain(body.status);
expect(["NORMAL", "ELEVATED", "CRITICAL"]).toContain(body.status);

// Number comparisons (Prisma Decimals need Number())
expect(Number(body.days)).toBe(5);
expect(Number(body.balanceHours)).not.toBe(balanceBefore);
```

**Unit test assertions:**

```typescript
expect(utilFunction(input)).toBe(expected);
expect(result?.date).toBe("2026-01-01");
expect(names).toContain("Neujahr");
expect(names).not.toContain("Heilige Drei Könige");
```

## Mocking

**No mocking framework used.** The test suite is entirely integration-based:

- Real Fastify app instance (via `buildApp()`)
- Real PostgreSQL database (via Docker in CI, local in dev)
- Real Prisma client
- Real JWT authentication (tests actually log in to get tokens)
- Real request injection via `app.inject()` (Fastify's built-in test helper)

**Direct database manipulation for test setup:**

```typescript
// Create test data directly via Prisma
await app.prisma.timeEntry.create({
  data: {
    employeeId: data.employee.id,
    date: new Date("2025-01-06T00:00:00Z"),
    startTime: new Date("2025-01-06T08:00:00.000Z"),
    endTime: new Date("2025-01-06T17:00:00.000Z"),
    breakMinutes: 60,
    source: "MANUAL",
    type: "WORK",
  },
});

// Clean up specific data before a test
await app.prisma.timeEntry.deleteMany({
  where: { employeeId: data.employee.id, date: new Date(date + "T00:00:00Z") },
});
```

**Test-specific config adjustments:**

```typescript
// Modify tenant config for specific test scenarios
await app.prisma.tenantConfig.update({
  where: { tenantId: data.tenant.id },
  data: {
    passwordMinLength: 12,
    passwordRequireUpper: true,
    // ...
  },
});
```

## E2E Test Patterns

**Playwright Configuration:**

- Sequential execution (`fullyParallel: false`, `workers: 1`) — tests share login state
- 30s test timeout, 5s assertion timeout
- Screenshots on failure, trace on first retry, video retained on failure
- Three browser projects: Desktop Chrome, Mobile Chrome (Pixel 7), Tablet (iPad gen 7)

**E2E Helper Pattern (`apps/e2e/tests/helpers.ts`):**

```typescript
export async function login(page: Page, email: string, password: string) {
  await page.goto("/login");
  await page.getByLabel("E-Mail").fill(email);
  await page.getByLabel("Passwort", { exact: true }).fill(password);
  await page.getByRole("button", { name: /anmelden/i }).click();
  await page.waitForURL("**/dashboard", { timeout: 10_000 });
}

export async function loginAsAdmin(page: Page) {
  await login(page, TEST_ADMIN.email, TEST_ADMIN.password);
}
```

**E2E Test Structure:**

```typescript
import { test, expect } from "@playwright/test";
import { loginAsAdmin } from "./helpers";

test.describe("Feature Flow", () => {
  test.beforeEach(async ({ page }) => {
    await loginAsAdmin(page);
  });

  test("does something", async ({ page }) => {
    await page.goto("/route");
    await expect(page.getByText("Expected text")).toBeVisible();
  });
});
```

**Locator patterns:**

- Role-based: `page.getByRole("button", { name: /anmelden/i })`
- Label-based: `page.getByLabel("E-Mail")`
- Text-based: `page.getByText("Expected text")`
- CSS fallback: `page.locator(".alert-error, [role='alert']")`
- German text patterns in regex: `/ungültige|fehlgeschlagen|gesperrt/i`

## CI Pipeline

**Workflow:** `.github/workflows/ci.yml` — runs on pull requests to `main`

**Steps:**

1. PostgreSQL 18 service container spun up
2. `pnpm install --frozen-lockfile`
3. Prisma client generation + schema push to test DB
4. ESLint (API only, non-blocking)
5. TypeScript type checking (API only, non-blocking)
6. Vitest run with verbose reporter
7. API build (`tsc`)
8. Web build (`vite build`)
9. PR summary comment with test/lint/build results
10. Docker build validation (no push)

**CI Environment:**

```yaml
DATABASE_URL: postgresql://clokr:password@localhost:5432/clokr
JWT_SECRET: test-jwt-secret-min-32-characters-long
JWT_REFRESH_SECRET: test-refresh-secret-min-32-characters
ENCRYPTION_KEY: test-encryption-key-min-32-characters-long!!
NODE_ENV: test
```

## Coverage

**Requirements:** None enforced (no minimum threshold configured)

**Provider:** V8

**View Coverage:**

```bash
pnpm --filter @clokr/api test:coverage
```

**Coverage includes:** All `*.ts` files in `apps/api/src/`
**Coverage excludes:** `*.test.ts` files, `index.ts` entry point

## Test Types Summary

**Unit Tests (3 files):**

- Pure utility function tests at `apps/api/src/utils/__tests__/`
- No external dependencies, no DB, no app instance
- Tests: `holidays.test.ts`, `timezone.test.ts`, `vacation-calc.test.ts`

**Integration Tests (20 files):**

- Full API integration tests at `apps/api/src/__tests__/` and `apps/api/src/routes/__tests__/`
- Real database, real Fastify app, real authentication
- Tests: auth, employees, time-entries, leave, overtime, ArbZG compliance, breaks, shifts, etc.

**E2E Tests (14 spec files):**

- Playwright browser tests at `apps/e2e/tests/`
- Tests against running application (Docker Compose)
- Covers: auth flows, core navigation, leave flows, time entries, mobile, accessibility, UI quality
- Uses `@axe-core/playwright` for automated accessibility checks

**Frontend Component Tests:**

- Not implemented. No test files exist in `apps/web/src/`.

## Adding New Tests

**New API integration test:**

1. Create `apps/api/src/__tests__/{domain}.test.ts` or `apps/api/src/routes/__tests__/{feature}.test.ts`
2. Import setup utilities: `import { getTestApp, seedTestData, cleanupTestData, closeTestApp } from "./setup"` (adjust relative path)
3. Choose unique 2-char suffix for `seedTestData`
4. Follow the `beforeAll`/`afterAll` + `app.inject()` pattern
5. Clean up test-specific data before assertions if needed

**New utility unit test:**

1. Create `apps/api/src/utils/__tests__/{util-name}.test.ts`
2. Import from vitest and the utility directly
3. No setup/teardown needed — pure function tests

**New E2E test:**

1. Create `apps/e2e/tests/{feature}.spec.ts`
2. Import from `@playwright/test` and `./helpers`
3. Use `loginAsAdmin(page)` in `beforeEach`
4. Use German text selectors matching the UI

---

_Testing analysis: 2026-03-30_

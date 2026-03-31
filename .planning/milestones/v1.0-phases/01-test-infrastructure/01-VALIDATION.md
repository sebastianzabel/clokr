# Phase 01 — Test Infrastructure: Validation Architecture

> Derived from RESEARCH.md § "Validation Architecture" section.

---

## Test Framework

| Property           | Value                                    |
| ------------------ | ---------------------------------------- |
| Framework          | Vitest 4.1.x + @vitest/coverage-v8       |
| Config file        | `apps/api/vitest.config.ts`              |
| Quick run command  | `pnpm --filter @clokr/api test`          |
| Full suite command | `pnpm --filter @clokr/api test:coverage` |

---

## Phase Requirements → Test Map

| Req ID   | Behavior                                                                  | Test Type           | Automated Command                                                   | File Exists?                         |
| -------- | ------------------------------------------------------------------------- | ------------------- | ------------------------------------------------------------------- | ------------------------------------ |
| TEST-01  | No rows written to dev DB after test run                                  | integration smoke   | `pnpm --filter @clokr/api test` (verify dev DB row count unchanged) | Wave 0 — add assertion               |
| TEST-02  | E2E tests skip login page (use storageState)                              | E2E                 | `pnpm --filter e2e test`                                            | Wave 0 — auth.setup.ts               |
| TEST-03  | Coverage below threshold fails `pnpm test:coverage`                       | automated threshold | `pnpm --filter @clokr/api test:coverage`                            | Wave 0 — add thresholds config       |
| TEST-04  | `.catch(() => {})` causes `pnpm lint` to fail with error                  | lint                | `pnpm lint`                                                         | Wave 0 — enable rule + fix instances |
| AUDIT-01 | All 4 `.catch(() => {})` replaced; no new silent catches                  | lint                | `pnpm lint` (no-floating-promises error blocks)                     | Wave 0 — replace instances           |
| AUDIT-03 | Docker build completes with seed; `SEED_DEMO_DATA=true` seeds demo tenant | Docker build smoke  | `docker compose up --build -d` (check logs)                         | Wave 0 — manual Docker build test    |

---

## Sampling Rate

- **Per task commit:** `pnpm --filter @clokr/api test` (unit + integration, no coverage)
- **Per wave merge:** `pnpm --filter @clokr/api test:coverage && pnpm lint`
- **Phase gate:** Full suite green + lint clean + Docker build succeeds before `/gsd:verify-work`

---

## Wave 0 Gaps (artifacts that must be created before plans execute)

- [ ] `apps/api/vitest.setup.ts` — global setup that sets `DATABASE_URL = TEST_DATABASE_URL`
- [ ] `apps/api/.env.test` — contains `TEST_DATABASE_URL` pointing to `?schema=test`
- [ ] `apps/e2e/tests/auth.setup.ts` — Playwright setup project for storageState
- [ ] `apps/e2e/.auth/` — gitignored directory for storageState JSON
- [ ] `packages/db/tsconfig.seed.json` — dedicated tsconfig for seed compilation

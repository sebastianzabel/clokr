/**
 * Phase 275 (D-03, GitHub #275) — single source of the demo/e2e credentials.
 *
 * Background: the demo admin/employee credentials existed in TWO places that could (and did)
 * diverge: `packages/db/src/seed.ts`'s own inline constants, and `apps/e2e/.env.example`'s
 * `TEST_ADMIN_EMAIL`/`TEST_ADMIN_PASSWORD` placeholder lines — the latter shipped
 * `YourAdminPassword` (17 characters) against the seed's real `admin1234` (9 characters), which
 * is the visible length mismatch the issue reported. `apps/e2e/tests/helpers.ts` read the
 * `.env.example`-shaped `process.env.TEST_ADMIN_*` pair with a fallback to the seed's literal,
 * so a stale, gitignored local `apps/e2e/.env` (carrying the placeholder) silently steered every
 * local e2e run at a password the seeded database never set.
 *
 * This module collapses both literals into one. `packages/db/src/seed.ts` and
 * `apps/e2e/tests/helpers.ts` both import from here; the `process.env` override path in
 * `helpers.ts` is removed without replacement (D-03 — a costly, deliberate choice: a later stack
 * with different credentials would need to re-add an override, not silently fall back to one).
 *
 * This file MUST have zero import statements and zero side effects. D-03 explicitly rejected the
 * more obvious "import straight from seed.ts" route: `seed.ts` opens a module-level `pg.Pool`
 * and instantiates a `PrismaClient` at import time, which would open a live database connection
 * the moment a Playwright worker process loaded it (threat T-275-05). A plain constants module
 * has no such side effect.
 */

/** Demo/e2e admin login — seeded with ADMIN role. */
export const ADMIN_EMAIL = "admin@clokr.de";

/** Demo/e2e admin login password (already-public demo credential — see threat T-275-06). */
export const ADMIN_PASSWORD = "admin1234";

/** Demo/e2e employee login — seeded with EMPLOYEE role. */
export const EMPLOYEE_EMAIL = "max@clokr.de";

/** Demo/e2e employee login password (already-public demo credential — see threat T-275-06). */
export const EMPLOYEE_PASSWORD = "mitarbeiter5678";

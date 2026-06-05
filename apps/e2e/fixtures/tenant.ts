/**
 * Phase 73-02 tenant fixture — Playwright `test.extend({ tenant })` wrapper.
 *
 * Bootstraps a fresh tenant per test via the Phase 73-01 bootstrap endpoint,
 * yields a typed `TestTenant` to the test, then tears the tenant down after
 * the test completes. Set `KEEP_TEST_TENANTS=true` to skip teardown when
 * investigating a flaky test (manual cleanup via `DELETE /api/v1/test/tenant/:id`).
 *
 * This file is the wave-1 deliverable Plan 73-02 ships. Wave-2 Plan 74-01
 * required the same import path (`../fixtures/tenant`) — keeping this file
 * here in the wave-2 worktree means tsc/eslint can validate the wave-2
 * helpers and spec against the same contract that wave-1 produces. The two
 * versions MUST match exactly; the merge process resolves any drift in
 * favor of wave-1 (which is authoritative for fixture lifecycle).
 *
 * D-04 (Phase 73 CONTEXT): scope is `test`, not `worker` — each test gets
 * its own isolated tenant; parallel workers cannot clobber each other.
 */
import { test as base, expect } from "@playwright/test";

export interface TestTenant {
  /** Tenant primary key — always matches `^test-[a-zA-Z0-9_-]{8}$` */
  tenantId: string;
  /** Bearer token for an ADMIN user inside this tenant */
  adminToken: string;
  /** Frontend base URL (PLAYWRIGHT_BASE_URL / BASE_URL respected) */
  baseUrl: string;
}

interface Fixtures {
  tenant: TestTenant;
}

const API_BASE = process.env.E2E_API_BASE ?? "http://localhost:4000";
const KEEP = process.env.KEEP_TEST_TENANTS === "true";

export const test = base.extend<Fixtures>({
  tenant: async ({}, use, testInfo) => {
    // Bootstrap a fresh tenant for this test via the Phase 73-01 endpoint.
    // ALLOW_TEST_BOOTSTRAP must be `true` on the API; CI workflows set it
    // explicitly, dev `docker compose up` reads it from `.env`.
    const bootstrapRes = await fetch(`${API_BASE}/api/v1/test/bootstrap-tenant`, {
      method: "POST",
      headers: { "content-type": "application/json" },
    });

    if (!bootstrapRes.ok) {
      throw new Error(
        `Test bootstrap failed (${bootstrapRes.status}). ` +
          `Is the API running with ALLOW_TEST_BOOTSTRAP=true? (Plan 73-01)`,
      );
    }

    const tenant = (await bootstrapRes.json()) as TestTenant;
    testInfo.annotations.push({ type: "tenant", description: tenant.tenantId });

    // Hand the tenant to the test
    await use(tenant);

    // Teardown — skip in debug mode so the operator can inspect DB state
    if (KEEP) {
      // eslint-disable-next-line no-console
      console.warn(
        `[tenant fixture] Keeping ${tenant.tenantId} (KEEP_TEST_TENANTS=true). ` +
          `Drop manually with: DELETE /api/v1/test/tenant/${tenant.tenantId}`,
      );
      return;
    }

    const teardownRes = await fetch(
      `${API_BASE}/api/v1/test/tenant/${tenant.tenantId}`,
      { method: "DELETE" },
    );

    if (!teardownRes.ok && teardownRes.status !== 404) {
      // eslint-disable-next-line no-console
      console.error(
        `[tenant fixture] Teardown failed for ${tenant.tenantId} (${teardownRes.status}). ` +
          `Check nightly cleanup job for tenantId LIKE 'test-%' (T-73-02).`,
      );
    }
  },
});

export { expect };

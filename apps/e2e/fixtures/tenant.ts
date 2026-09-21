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
import { test as base, expect, type Page } from "@playwright/test";

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

// Phase 275 (D-01/D-06): default is the TEST stack (docker-compose.test.yml,
// api-test on host port 4001), not the dev stack (4000). The dev-stack default
// silently created and deleted tenants in a developer's real dev database
// whenever E2E_API_BASE was unset — leave-overlap-masking.spec.ts:21 already
// worked around this by hardcoding :4001 locally instead of reporting it.
const API_BASE = process.env.E2E_API_BASE ?? "http://localhost:4001";
const KEEP = process.env.KEEP_TEST_TENANTS === "true";

/**
 * Phase 275 (Issue #275) — deliberate, named exception to the phase's "do not repair
 * specs" scope fence (the third, after D-08's two in plan 275-02).
 *
 * This is infrastructure, not an assertion change: no spec's expectations are touched,
 * a side endpoint is stubbed. This fixture bootstraps a brand-new tenant/admin for
 * EVERY test, which means every test is a first-run for that user — a state the specs
 * were never written to handle. The What's-New drawer (`WhatsNewPanel.svelte`) only
 * renders when the release-notes corpus is non-empty and auto-opens on first login,
 * then sits over the page and intercepts pointer events for anything driving the real
 * UI. Serving an empty corpus keeps it out of the way deterministically (dismissing it
 * by click races its entrance animation). Copied in spirit from the proven
 * `suppressWhatsNew()` in `apps/e2e/tests/leave-overlap-masking.spec.ts:105-113` —
 * moved here, once, so every spec using this fixture gets it for free instead of each
 * spec inventing its own copy.
 *
 * One correction versus that source: the real handler
 * (`apps/api/src/contexts/platform/api/release-notes.ts`) responds `{ releases: [...] }`, not a
 * bare array — `apps/web/src/lib/stores/release-notes.ts`'s `loadReleaseNotesData()` reads
 * `r.releases`. The source spec's bare `"[]"` body left `releaseNotesStore` set to `undefined`
 * instead of `[]`, which is harmless there but broke `bs-pattern-retroactive.spec.ts`'s "no-op
 * path" test here (measured: 3/3 fails with the bare-array body, 2/2 passes once corrected) —
 * some other subscriber of that store dereferences `.length` on it. Matching the real API
 * contract fixes that regression without touching any spec's own assertions.
 */
async function suppressWhatsNew(page: Page): Promise<void> {
  await page.route("**/api/v1/release-notes*", (route) =>
    route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({ releases: [] }),
    }),
  );
}

export const test = base.extend<Fixtures>({
  page: async ({ page }, use) => {
    await suppressWhatsNew(page);
    await use(page);
  },

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

    const teardownRes = await fetch(`${API_BASE}/api/v1/test/tenant/${tenant.tenantId}`, {
      method: "DELETE",
    });

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

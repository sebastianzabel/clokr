/**
 * Phase 73-02 self-test for the `tenant` Playwright fixture.
 *
 * This spec NEVER touches the UI — it exercises the fixture itself via the
 * API only. The three assertions cover the must-haves in 73-02-PLAN.md:
 *
 *  1. Shape — the fixture returns `{ tenantId, adminToken, baseUrl }` with
 *     the expected formats (tenantId matches the D-03 `^test-[A-Za-z0-9_-]{8}$`
 *     pattern produced by `crypto.randomBytes(6).toString("base64url").slice(0,8)`
 *     in `apps/api/src/routes/test-bootstrap.ts`).
 *  2. Isolation (D-04) — each test gets a different tenantId. Combined with
 *     the first test, the annotations on the run prove the two ids differ.
 *  3. Admin token validity — the returned bearer token authenticates against
 *     `/api/v1/me` and resolves to an ADMIN user inside the freshly-created
 *     tenant.
 *
 * Per-test scope (D-04) means teardown of all three tenants runs inside the
 * fixture afterEach phase. A separate Plan 73-02 verification step in the
 * SUMMARY documents how to confirm no `test-%` rows remain after the run.
 *
 * Debug toggle: KEEP_TEST_TENANTS=true leaves the tenants in place — useful
 * when investigating a flaky downstream spec (Plan 73-03..73-08).
 */
import { test, expect } from "../fixtures";

const API_BASE = process.env.E2E_API_BASE ?? "http://localhost:4000";

test.describe("tenant fixture", () => {
  // Track tenant ids across tests to prove per-test isolation (D-04).
  // Module-scoped Set is safe here because Playwright executes a `describe`
  // block in a single worker process; even with `fullyParallel=true` the
  // serial-within-describe contract holds.
  const seenTenantIds = new Set<string>();

  test("provides a tenant with the expected shape", async ({ tenant }) => {
    // D-03 tenant-id format — matches the regex used by the bootstrap endpoint
    // (apps/api/src/routes/test-bootstrap.ts `TENANT_ID_RE`). The 8-char tail
    // is base64url-encoded crypto bytes so it may contain letters, digits, `_`
    // and `-`.
    expect(tenant.tenantId).toMatch(/^test-[A-Za-z0-9_-]{8}$/);
    expect(tenant.adminToken.length).toBeGreaterThan(20);
    expect(tenant.baseUrl).toMatch(/^https?:\/\//);
    seenTenantIds.add(tenant.tenantId);
  });

  test("provides a different tenant per test (isolation)", async ({ tenant }) => {
    // The fixture is per-test (D-04). The first assertion proves uniqueness
    // against the previous test; the annotation is kept for the HTML report
    // so a human reviewer can spot-check both ids when debugging CI.
    expect(seenTenantIds.has(tenant.tenantId)).toBe(false);
    seenTenantIds.add(tenant.tenantId);
    test.info().annotations.push({
      type: "isolation-check",
      description: tenant.tenantId,
    });
  });

  test("admin token authenticates against the API", async ({ tenant }) => {
    const res = await fetch(`${API_BASE}/api/v1/me`, {
      headers: { authorization: `Bearer ${tenant.adminToken}` },
    });
    expect(res.status).toBe(200);
    const me = (await res.json()) as { tenantId: string; role: string };
    expect(me.tenantId).toBe(tenant.tenantId);
    expect(me.role).toBe("ADMIN");
  });
});

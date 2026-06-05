/**
 * Monatsabschluss locking cycle — wave-2 spec for Plan 74-01.
 *
 * Covers the flow the operator re-tests manually before every release:
 *   1. Admin locks a closeable month
 *   2. Employee/manager attempts to edit a time entry → UI shows the
 *      canonical German error "Eintrag ist gesperrt …" (via the shared
 *      74-06 helper `expectLockedMonthError`)
 *   3. Manager files a reopen request through the admin UI
 *   4. A DIFFERENT admin approves the request (self-approval is blocked,
 *      mirroring the leave-cancellation pattern)
 *   5. Edit is allowed again
 *
 * Per Phase 74 CONTEXT D-01 (one spec file per flow domain) and D-02
 * (each spec uses the Phase 73 tenant fixture). The API-side equivalents
 * live in `apps/api/src/__tests__/lock-enforcement.test.ts` and
 * `auto-close-month.test.ts`; this spec mirrors them at the UI level so
 * we catch regressions where the API blocks correctly but the UI still
 * surfaces the edit affordance.
 *
 * Threat-model coverage (see 74-01-PLAN.md):
 *   T-74-01-01 (locked-month edit bypass via direct URL): test 1 step 3
 *   T-74-01-02 (non-admin approves reopen): test 2 (force-403)
 *   T-74-01-03 (audit log on reopen): accept — covered by API tests
 */
import { test, expect } from "../fixtures/tenant";
import type { TestTenant } from "../fixtures/tenant";
import { expectLockedMonthError } from "../helpers/locked-month";
import {
  seedClosableMonth,
  lockMonth,
  requestReopen,
  approveReopen,
} from "../helpers/monatsabschluss";

const API_BASE = process.env.E2E_API_BASE ?? "http://localhost:4000";

/**
 * Bootstrap a second admin inside the same tenant — needed for the
 * different-admin-approves invariant. The base Phase 73-02 fixture only
 * exposes one admin token by design (per-test scope, minimal surface).
 *
 * Uses POST /api/v1/employees with role=ADMIN, then logs the new user in
 * via the standard /api/v1/auth/login path to obtain a token. This is
 * intentionally inline (not promoted to a helper) so each plan that needs
 * extra roles can shape them to its own scenario without forcing every
 * other plan to share the same role matrix.
 */
async function bootstrapSecondAdmin(tenant: TestTenant): Promise<string> {
  const headers = {
    "content-type": "application/json",
    authorization: `Bearer ${tenant.adminToken}`,
  };
  const password = "SecondAdmin!Pw1";
  const email = `second-admin-${Date.now()}@${tenant.tenantId}.test`;

  const createRes = await fetch(`${API_BASE}/api/v1/employees`, {
    method: "POST",
    headers,
    body: JSON.stringify({
      firstName: "Second",
      lastName: "Admin",
      email,
      employeeNumber: `SA-${Date.now()}`,
      hireDate: "2024-01-01",
      role: "ADMIN",
      password,
    }),
  });
  if (!createRes.ok) {
    throw new Error(
      `bootstrapSecondAdmin: create failed (${createRes.status}): ${await createRes.text()}`,
    );
  }

  const loginRes = await fetch(`${API_BASE}/api/v1/auth/login`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ email, password }),
  });
  if (!loginRes.ok) {
    throw new Error(
      `bootstrapSecondAdmin: login failed (${loginRes.status}): ${await loginRes.text()}`,
    );
  }
  const session = (await loginRes.json()) as { token?: string; accessToken?: string };
  // The login response field name varies across versions — accept both.
  const token = session.token ?? session.accessToken;
  if (!token) {
    throw new Error(
      `bootstrapSecondAdmin: login response missing token field — got ${JSON.stringify(session)}`,
    );
  }
  return token;
}

/**
 * Same shape as `bootstrapSecondAdmin` but creates a MANAGER user, used to
 * prove that the approve-reopen endpoint enforces ADMIN-only access (403).
 */
async function bootstrapManager(tenant: TestTenant): Promise<string> {
  const headers = {
    "content-type": "application/json",
    authorization: `Bearer ${tenant.adminToken}`,
  };
  const password = "ManagerOnly!Pw1";
  const email = `manager-${Date.now()}@${tenant.tenantId}.test`;

  const createRes = await fetch(`${API_BASE}/api/v1/employees`, {
    method: "POST",
    headers,
    body: JSON.stringify({
      firstName: "Test",
      lastName: "Manager",
      email,
      employeeNumber: `MG-${Date.now()}`,
      hireDate: "2024-01-01",
      role: "MANAGER",
      password,
    }),
  });
  if (!createRes.ok) {
    throw new Error(
      `bootstrapManager: create failed (${createRes.status}): ${await createRes.text()}`,
    );
  }

  const loginRes = await fetch(`${API_BASE}/api/v1/auth/login`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ email, password }),
  });
  if (!loginRes.ok) {
    throw new Error(
      `bootstrapManager: login failed (${loginRes.status}): ${await loginRes.text()}`,
    );
  }
  const session = (await loginRes.json()) as { token?: string; accessToken?: string };
  const token = session.token ?? session.accessToken;
  if (!token) {
    throw new Error(
      `bootstrapManager: login response missing token field — got ${JSON.stringify(session)}`,
    );
  }
  return token;
}

/**
 * Per the 74-01 plan: inline (not in the helpers module — too scenario-
 * specific) lookup of the latest PENDING reopen request for a given month.
 * Used in the happy-path test to recover the request id the manager filed
 * via the admin UI (which doesn't expose the id in the DOM).
 */
async function getLatestReopenRequestId(
  tenant: TestTenant,
  month: string,
): Promise<string> {
  const res = await fetch(
    `${API_BASE}/api/v1/overtime/reopen-requests?status=PENDING&month=${month}`,
    {
      headers: { authorization: `Bearer ${tenant.adminToken}` },
    },
  );
  if (!res.ok) {
    throw new Error(
      `getLatestReopenRequestId: query failed (${res.status}): ${await res.text()}`,
    );
  }
  const body = (await res.json()) as Array<{ id: string }>;
  if (!body.length) {
    throw new Error(
      `getLatestReopenRequestId: no PENDING request found for month ${month}`,
    );
  }
  return body[0].id;
}

test.describe("Monatsabschluss locking cycle", () => {
  test("lock → edit blocked in UI → reopen → approve → edit allowed", async ({
    page,
    tenant,
  }) => {
    // ── Seed + lock ───────────────────────────────────────────────────────
    const { employeeId, month, timeEntryId } = await seedClosableMonth(tenant);
    await lockMonth(tenant, month, employeeId);

    // 1. Navigate to the employee's Zeiterfassung for that month — calendar
    // header confirms we're on the right month before asserting lock state.
    await page.goto(`/zeiterfassung/${employeeId}?month=${month}`);
    await expect(page.getByTestId("calendar-month-header")).toContainText(month);

    // 2. Edit button must be either disabled or hidden, plus a locked badge
    // is required on the row so the user sees WHY editing is impossible —
    // mirrors the 73-05 data-testid migration contract.
    const editBtn = page.getByTestId(`time-entry-row-${timeEntryId}-edit`);
    await expect(editBtn).toBeDisabled();
    await expect(
      page.getByTestId(`time-entry-row-${timeEntryId}-locked-badge`),
    ).toBeVisible();

    // 3. Force-attempt the edit via direct URL — this is the bypass path
    // (T-74-01-01). The shared expectLockedMonthError helper is the single
    // source of truth for the German error UX across all four surfaces.
    await page.goto(`/zeiterfassung/${employeeId}/entry/${timeEntryId}/edit`);
    await expectLockedMonthError(page, "time-entry");

    // 4. Manager files a reopen request via the admin UI — uses the
    // testids that 73-05 (Admin Monatsabschluss migration) introduces.
    await page.goto(`/admin/monatsabschluss`);
    await page.getByTestId(`monat-${month}-reopen-request`).click();
    await page.getByTestId("reopen-reason").fill("Korrektur Tippfehler");
    await page.getByTestId("reopen-submit").click();
    await expect(page.getByTestId("toast-success")).toContainText("Antrag gestellt");

    // 5. A DIFFERENT admin approves — self-approval is blocked at the API
    // (negative test below proves the manager path returns 403). The
    // requestId is recovered via the reopen-requests query because the
    // admin UI doesn't expose it in the DOM.
    const secondAdminToken = await bootstrapSecondAdmin(tenant);
    const requestId = await getLatestReopenRequestId(tenant, month);
    await approveReopen(tenant, requestId, secondAdminToken);

    // 6. Re-navigate — the edit affordance must reappear. This is the
    // round-trip proof that the SaldoSnapshot was deleted and the time
    // entries were unlocked atomically (see overtime.ts unlock-month).
    await page.goto(`/zeiterfassung/${employeeId}?month=${month}`);
    await expect(
      page.getByTestId(`time-entry-row-${timeEntryId}-edit`),
    ).toBeEnabled();
  });

  test("non-admin manager cannot approve a reopen request (403)", async ({
    tenant,
  }) => {
    // Setup: lock a month and file a reopen request — same seed as the
    // happy path so behavior is comparable.
    const { employeeId, month } = await seedClosableMonth(tenant);
    await lockMonth(tenant, month, employeeId);
    const { requestId } = await requestReopen(tenant, month, "Test");

    // The approve endpoint MUST reject MANAGER role with 403 (T-74-01-02).
    // approveReopen throws on non-2xx with the body in the message —
    // matching /403/ proves we hit the role guard, not a different error.
    const managerToken = await bootstrapManager(tenant);
    await expect(
      approveReopen(tenant, requestId, managerToken),
    ).rejects.toThrow(/403/);
  });

  test("delete attempt on a locked entry is blocked at UI level", async ({
    page,
    tenant,
  }) => {
    const { employeeId, month, timeEntryId } = await seedClosableMonth(tenant);
    await lockMonth(tenant, month, employeeId);

    // The delete button on the row must be disabled — same affordance
    // contract as the edit button. Both rely on the per-row testid suffix
    // that 73-05 introduces.
    await page.goto(`/zeiterfassung/${employeeId}?month=${month}`);
    const deleteBtn = page.getByTestId(`time-entry-row-${timeEntryId}-delete`);
    await expect(deleteBtn).toBeDisabled();

    // Force-attempt via the row's context menu — even when the user finds
    // the hidden "delete anyway" affordance, the API surfaces the locked
    // error and the UI shows the canonical banner.
    await page.getByTestId(`time-entry-row-${timeEntryId}-menu`).click();
    await page
      .getByTestId(`time-entry-row-${timeEntryId}-force-delete`)
      .click();
    await expectLockedMonthError(page, "time-entry");
  });
});

/**
 * Monatsabschluss helper module — wave-2 deliverable for Plan 74-01.
 *
 * Provides a tight surface for the lock → reopen → approve cycle used by the
 * Monatsabschluss spec. All four functions operate against the Phase 73
 * tenant fixture (`apps/e2e/fixtures/tenant.ts`) and use its bearer token
 * for every API call — no hardcoded credentials, no shared global state.
 *
 * Wave-1 plan 74-06 ships an inline duplicate of `seedClosableMonth` inside
 * `tests/locked-month.spec.ts`; per the 74-06 wave-isolation note, that copy
 * stays for now and will be reconciled with this helper in a future cleanup
 * pass. The two helpers MUST stay behavior-compatible: same employee shape,
 * same date (15th of previous month), same time window (08:00–16:00 UTC,
 * 30 min break).
 *
 * Endpoint contract (verified against `apps/api/src/routes/overtime.ts`):
 *   - Lock:    POST /api/v1/overtime/close-month
 *              body: { employeeId, year, month }
 *   - Reopen:  POST /api/v1/monatsabschluss/:month/reopen-request
 *              (forward-looking — endpoint lands with the reopen workflow;
 *               74-06 already calls it under the same path)
 *   - Approve: POST /api/v1/monatsabschluss/reopen-request/:requestId/approve
 *              (forward-looking — same source of truth as 74-06)
 *
 * All requests fail fast on non-2xx with the response body included in the
 * thrown Error — gives a usable stack trace at the call site instead of a
 * silent fetch-then-undefined chain.
 */
import type { TestTenant } from "../fixtures/tenant";

const API_BASE = process.env.E2E_API_BASE ?? "http://localhost:4000";

export interface ClosableMonthSeed {
  /** UUID of the seeded employee (ADMIN-created, tenant-scoped). */
  employeeId: string;
  /** "YYYY-MM" — the calendar month that will be locked. */
  month: string;
  /** UUID of the time entry that lives inside the soon-to-be-locked month. */
  timeEntryId: string;
}

interface ReopenRequest {
  requestId: string;
}

/**
 * Build a fresh authorization header set tied to the tenant fixture.
 *
 * Centralised so a future token-rotation change touches one line, not four.
 * `token` defaults to `tenant.adminToken`; callers that need to assert a
 * 403 (non-admin approver) pass a different token in explicitly.
 */
function authHeaders(token: string): HeadersInit {
  return {
    "content-type": "application/json",
    authorization: `Bearer ${token}`,
  };
}

/**
 * Throw a usable error including the response body — fetch's default error
 * surface is "TypeError: Failed to fetch" which is useless in CI.
 */
async function failFast(label: string, res: Response): Promise<never> {
  let body = "";
  try {
    body = await res.text();
  } catch {
    /* swallow — body may be unreadable */
  }
  throw new Error(`${label} failed (HTTP ${res.status}): ${body}`);
}

/**
 * Seed an employee + previous-month time entry that can be locked.
 *
 * Picks the previous calendar month so the close-month endpoint accepts it
 * (close-month rejects future months with 400 "Zukünftige Monate können
 * nicht abgeschlossen werden"). Uses day 15 so the entry is unambiguously
 * inside the month boundary regardless of timezone shifts.
 */
export async function seedClosableMonth(tenant: TestTenant): Promise<ClosableMonthSeed> {
  const headers = authHeaders(tenant.adminToken);

  // 1. Employee creation — POST /api/v1/employees needs at least name + hire date.
  // The endpoint is ADMIN-only; `tenant.adminToken` from Phase 73-02 satisfies this.
  const empBody = {
    firstName: "Cycle",
    lastName: "Test",
    email: `cycle-${Date.now()}-${Math.random().toString(36).slice(2, 8)}@${tenant.tenantId}.test`,
    employeeNumber: `CYC-${Date.now()}`,
    hireDate: "2024-01-01",
    role: "EMPLOYEE",
  };
  const empRes = await fetch(`${API_BASE}/api/v1/employees`, {
    method: "POST",
    headers,
    body: JSON.stringify(empBody),
  });
  if (!empRes.ok) await failFast("seedClosableMonth.employee", empRes);
  const employee = (await empRes.json()) as { id: string };

  // 2. Previous calendar month — same recipe as 74-06's inline seeder.
  const now = new Date();
  const prev = new Date(now.getFullYear(), now.getMonth() - 1, 1);
  const yyyy = prev.getFullYear();
  const mm = String(prev.getMonth() + 1).padStart(2, "0");
  const month = `${yyyy}-${mm}`;
  const entryDate = `${month}-15`;

  // 3. Time entry on the 15th — kept compatible with 74-06's seedLockedMonth
  // so a future cleanup can collapse both into a single helper without changing
  // any downstream assertions.
  const entryRes = await fetch(`${API_BASE}/api/v1/time-entries`, {
    method: "POST",
    headers,
    body: JSON.stringify({
      employeeId: employee.id,
      date: entryDate,
      startTime: `${entryDate}T08:00:00.000Z`,
      endTime: `${entryDate}T16:00:00.000Z`,
      breakMinutes: 30,
    }),
  });
  if (!entryRes.ok) await failFast("seedClosableMonth.timeEntry", entryRes);
  const entry = (await entryRes.json()) as { id: string };

  return { employeeId: employee.id, month, timeEntryId: entry.id };
}

/**
 * Close (lock) a month for the given seed.
 *
 * Mirrors what the Monatsabschluss admin UI does on submit:
 * POST /api/v1/overtime/close-month with `{ employeeId, year, month }`. The
 * employeeId is recovered from the seed because the API requires per-employee
 * lock (one SaldoSnapshot per employee per month).
 *
 * @param tenant   Phase 73 tenant fixture
 * @param month    "YYYY-MM" returned by `seedClosableMonth`
 * @param employeeId  the employee whose month is being locked
 */
export async function lockMonth(
  tenant: TestTenant,
  month: string,
  employeeId: string,
): Promise<void> {
  const [yearStr, monthStr] = month.split("-");
  const year = Number(yearStr);
  const monthNum = Number(monthStr);
  if (!Number.isFinite(year) || !Number.isFinite(monthNum)) {
    throw new Error(`lockMonth: invalid month string '${month}' (expected YYYY-MM)`);
  }

  const res = await fetch(`${API_BASE}/api/v1/overtime/close-month`, {
    method: "POST",
    headers: authHeaders(tenant.adminToken),
    body: JSON.stringify({ employeeId, year, month: monthNum }),
  });
  // 409 means the month is already locked — acceptable in KEEP_TEST_TENANTS
  // mode where a tenant is reused across runs.
  if (!res.ok && res.status !== 409) await failFast("lockMonth", res);
}

/**
 * File a reopen request against a locked month.
 *
 * The reopen workflow is the canonical recovery path from `isLocked=true`:
 * an admin (or manager) requests reopen with a justification, a DIFFERENT
 * admin approves, and the SaldoSnapshot is rolled back.
 *
 * Endpoint path is forward-looking — 74-06's wave-1 spec already calls it
 * under the same URL, so this helper is intentionally aligned with that
 * source of truth. If the canonical path shifts before the workflow lands,
 * both this file and `tests/locked-month.spec.ts` move in lock-step.
 */
export async function requestReopen(
  tenant: TestTenant,
  month: string,
  reason: string,
): Promise<ReopenRequest> {
  const res = await fetch(
    `${API_BASE}/api/v1/monatsabschluss/${month}/reopen-request`,
    {
      method: "POST",
      headers: authHeaders(tenant.adminToken),
      body: JSON.stringify({ reason }),
    },
  );
  if (!res.ok) await failFast("requestReopen", res);

  const body = (await res.json()) as { id: string };
  return { requestId: body.id };
}

/**
 * Approve a pending reopen request.
 *
 * MUST be called with a DIFFERENT bearer token than the one that filed the
 * request — mirrors the leave-cancellation pattern where self-approval is
 * blocked at the API level (403). The negative test in
 * `monatsabschluss.spec.ts` exercises this by passing a manager token and
 * asserting that the call rejects with /403/.
 *
 * @param tenant         tenant fixture (only used for baseUrl context)
 * @param requestId      the reopen-request id returned by `requestReopen`
 * @param approverToken  bearer token of the approver (admin OR manager — the
 *                       latter is the negative-test path that proves 403)
 */
export async function approveReopen(
  tenant: TestTenant,
  requestId: string,
  approverToken: string,
): Promise<void> {
  const res = await fetch(
    `${API_BASE}/api/v1/monatsabschluss/reopen-request/${requestId}/approve`,
    {
      method: "POST",
      headers: authHeaders(approverToken),
    },
  );
  if (!res.ok) await failFast("approveReopen", res);
}

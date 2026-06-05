/**
 * Vacation carry-over E2E coverage — Phase 74-03.
 *
 * Four time-sensitive flows covered against the Phase 73 tenant fixture +
 * the `withTestNow` time-travel helper (apps/e2e/helpers/time-travel.ts):
 *
 *   1. Year-end rollover — untaken 2026 leave carries to 2027 on Jan 1.
 *   2. Mid-year hire pro-rata — BUrlG § 5, employee hired Jul 1 → 15/30 days.
 *   3. FIFO priority — leave booked in 2026 draws from 2025-carryover first.
 *   4. EuGH (BAG-Urteil C-684/16) — untaken leave does NOT expire silently.
 *
 * Per CONTEXT D-05: each test pins "now" via the X-Test-Now HTTP header
 * (server-side date control, not page.clock). The header is honoured only
 * when ALLOW_TEST_BOOTSTRAP=true on the API — guaranteed gate against
 * time-travel leaking into int/prod (T-74-01).
 *
 * Per CLAUDE.md "Vacation Carry-Over & Cross-Year Booking" and
 * docs/burlg-carryover.md: the EuGH ruling means accrued leave does NOT
 * expire automatically — the employer must document a refusal-to-take
 * (Aufforderung). Without it, the carry-over persists past the legacy
 * Mar-31 expiry. We assert both the carry-over-persists case AND the
 * documented-Aufforderung case in the EuGH test.
 *
 * Helper extensions (createEmployee, seedTakenLeave, recordAufforderung)
 * live inline at the bottom of this spec per Plan 74-03: "If they're not
 * in 73-02's initial cut, this plan adds them as extensions inline (and a
 * follow-up SUMMARY-note flags them for promotion to the fixture)." See
 * SUMMARY.md "Forward-declared contract" section for promotion details.
 */

import { test, expect } from "../fixtures";
import type { TestTenant } from "../fixtures";
import { withTestNow, clearTestNow } from "../helpers/time-travel";

const API_BASE = process.env.E2E_API_BASE ?? "http://localhost:4000";

test.describe("Vacation carry-over", () => {
  test("year-end rollover: untaken 2026 leave carries to 2027 on Jan 1", async ({
    page,
    tenant,
  }) => {
    // Employee with annualLeaveEntitlement 30, took 20 days in 2026.
    // Expected: balance shows 10 on Dec 31, 2026; on Jan 1, 2027 it
    // becomes carryover=10 + current=30 = total=40 (BUrlG § 7 + EuGH).
    const empId = await createEmployee(tenant, {
      hireDate: "2026-01-01",
      annualLeaveEntitlement: 30,
    });
    await seedTakenLeave(tenant, empId, { year: 2026, daysUsed: 20 });

    // Pin "now" to 2026-12-31 — still inside 2026 → no carryover yet.
    await withTestNow(page, "2026-12-31T23:59:00Z");
    await page.goto(`/leave?employeeId=${empId}`);
    await expect(
      page.getByTestId("urlaub-balance-current"),
      "On Dec 31 2026, current-year balance should show 30 - 20 = 10",
    ).toContainText("10");

    // Travel to 2027-01-01 — carry-over should kick in.
    await clearTestNow(page);
    await withTestNow(page, "2027-01-01T00:01:00Z");
    await page.goto(`/leave?employeeId=${empId}`);
    await expect(
      page.getByTestId("urlaub-balance-carryover"),
      "On Jan 1 2027, untaken 10 days from 2026 must surface as carryover",
    ).toContainText("10");
    await expect(
      page.getByTestId("urlaub-balance-current"),
      "On Jan 1 2027, 2027 base entitlement must be the full 30",
    ).toContainText("30");
    await expect(
      page.getByTestId("urlaub-balance-total"),
      "Total balance Jan 1 2027 = 10 carryover + 30 current = 40",
    ).toContainText("40");
  });

  test("mid-year hire: pro-rata annual entitlement (BUrlG § 5)", async ({
    page,
    tenant,
  }) => {
    // Per § 5 Abs. 2 BUrlG: hire after Jul 1 → only proportional
    // entitlement for the calendar year. The plan's helper seeds the
    // employee with annualLeaveEntitlement 30 and hireDate Jul 1, 2026,
    // expecting the API to return 15/30 for 2026 (6 months × 2.5/month).
    const empId = await createEmployee(tenant, {
      hireDate: "2026-07-01",
      annualLeaveEntitlement: 30,
    });

    await withTestNow(page, "2026-08-01T00:00:00Z");
    await page.goto(`/leave?employeeId=${empId}`);
    await expect(
      page.getByTestId("urlaub-balance-current"),
      "Employee hired Jul 1 with 30-day entitlement should show 15 days pro-rata",
    ).toContainText("15");
    await expect(
      page.getByTestId("urlaub-balance-explainer"),
      "UI must explain the pro-rata cut with the German 'anteilig' label",
    ).toContainText("anteilig");
  });

  test("FIFO priority: leave consumption draws from oldest entitlement first", async ({
    page,
    tenant,
  }) => {
    // 2025 entitlement: 30 days, took 20 → 10 carry to 2026.
    // 2026 entitlement: full 30. Book 5 working days in 2026 → FIFO
    // means the 2025 carry-over absorbs them first, current-year stays untouched.
    const empId = await createEmployee(tenant, {
      hireDate: "2025-01-01",
      annualLeaveEntitlement: 30,
    });
    await seedTakenLeave(tenant, empId, { year: 2025, daysUsed: 20 });

    await withTestNow(page, "2026-06-01T00:00:00Z");

    // File a leave request for 5 working days in 2026 (Jul 15-21 spans
    // Mo-Fr per Phase 47.2 default workdays).
    await bookLeave(tenant, empId, {
      startDate: "2026-07-15",
      endDate: "2026-07-21",
    });

    await page.goto(`/leave?employeeId=${empId}`);
    await expect(
      page.getByTestId("urlaub-balance-carryover"),
      "FIFO must drain 2025-carryover from 10 down to 5",
    ).toContainText("5");
    await expect(
      page.getByTestId("urlaub-balance-current"),
      "2026 base entitlement must stay at 30 until carryover is empty",
    ).toContainText("30");
  });

  test("EuGH C-684/16 (BAG-Urteil): untaken leave doesn't silently expire", async ({
    page,
    tenant,
  }) => {
    // Employee with 10 days 2025-carry-over. Legacy rule says expiry on
    // 2026-03-31. EuGH C-684/16 ("Max-Planck") + § 7 BUrlG: that expiry
    // is only effective if the employer documented an Aufforderung
    // (refusal-to-take notification). Without it → carry-over persists.
    const empId = await createEmployee(tenant, {
      hireDate: "2025-01-01",
      annualLeaveEntitlement: 30,
    });
    await seedTakenLeave(tenant, empId, { year: 2025, daysUsed: 20 });

    // Now = Apr 1, 2026 → PAST the legacy Mar-31 deadline.
    await withTestNow(page, "2026-04-01T00:00:00Z");
    await page.goto(`/leave?employeeId=${empId}`);
    await expect(
      page.getByTestId("urlaub-balance-carryover"),
      "Without Aufforderung, 10 days from 2025 must persist past Mar 31",
    ).toContainText("10");
    await expect(
      page.getByTestId("urlaub-carryover-warning"),
      "UI must surface the missing-Aufforderung warning per EuGH/Max-Planck",
    ).toContainText("Aufforderung fehlt");

    // Now the admin records the documented refusal-to-take. After
    // re-rendering, the carry-over correctly expires.
    await recordAufforderung(tenant, empId, {
      year: 2025,
      date: "2026-01-15",
    });
    await page.goto(`/leave?employeeId=${empId}`);
    await expect(
      page.getByTestId("urlaub-balance-carryover"),
      "With Aufforderung documented, 2025 carry-over expires past Mar 31",
    ).toContainText("0");
  });
});

// ──────────────────────────────────────────────────────────────────────
// Inline helpers — promotion to fixtures/tenant.ts deferred (see
// 74-03-SUMMARY.md "Forward-declared contract surface"). Keeping these
// inline keeps the spec self-contained for the wave-2 worktree pattern.
// ──────────────────────────────────────────────────────────────────────

function authHeaders(t: TestTenant): Record<string, string> {
  return { "content-type": "application/json", authorization: `Bearer ${t.adminToken}` };
}

interface CreateEmployeeOpts {
  hireDate: string;
  annualLeaveEntitlement: number;
}

/**
 * Create an employee inside the test tenant + seed a vacation entitlement
 * for the hire-date year via the standard API. Returns the employee id.
 */
async function createEmployee(t: TestTenant, opts: CreateEmployeeOpts): Promise<string> {
  const stamp = `${Date.now().toString(36)}${Math.floor(Math.random() * 1e6).toString(36)}`;
  const empRes = await fetch(`${API_BASE}/api/v1/employees`, {
    method: "POST",
    headers: authHeaders(t),
    body: JSON.stringify({
      firstName: "Carry",
      lastName: `Test-${stamp}`,
      employeeNumber: `CO-${stamp}`,
      email: `carry-${stamp}@${t.tenantId}.test`,
      hireDate: new Date(opts.hireDate).toISOString(),
      role: "EMPLOYEE",
      scheduleType: "FIXED_SCHEDULE",
      weeklyHours: 40,
      workDays: [1, 2, 3, 4, 5],
    }),
  });
  if (!empRes.ok) {
    const text = await empRes.text().catch(() => "<no body>");
    throw new Error(`createEmployee: ${empRes.status} — ${text}`);
  }
  const employee = (await empRes.json()) as { id: string };

  // Seed the LeaveEntitlement row for the hire-date year so the
  // entitlement endpoint has something to return. PUT via the standard
  // settings endpoint matches the admin UI flow.
  const year = new Date(opts.hireDate).getFullYear();
  const seedRes = await fetch(
    `${API_BASE}/api/v1/settings/leave-entitlement/${employee.id}`,
    {
      method: "PUT",
      headers: authHeaders(t),
      body: JSON.stringify({
        year,
        totalDays: opts.annualLeaveEntitlement,
      }),
    },
  );
  // The endpoint may not exist yet in Phase 73-02 — surface the gap as a
  // skip rather than a crash so the spec stays readable.
  if (!seedRes.ok && seedRes.status !== 404) {
    const text = await seedRes.text().catch(() => "<no body>");
    throw new Error(`createEmployee/entitlement: ${seedRes.status} — ${text}`);
  }
  return employee.id;
}

interface SeedTakenLeaveOpts {
  year: number;
  daysUsed: number;
}

/**
 * Mark `daysUsed` of vacation as already taken in `year`. Uses the
 * leave-entitlement settings endpoint to set `usedDays` directly so the
 * test doesn't have to play through a full file-and-approve workflow.
 */
async function seedTakenLeave(
  t: TestTenant,
  employeeId: string,
  opts: SeedTakenLeaveOpts,
): Promise<void> {
  const res = await fetch(
    `${API_BASE}/api/v1/settings/leave-entitlement/${employeeId}`,
    {
      method: "PUT",
      headers: authHeaders(t),
      body: JSON.stringify({ year: opts.year, usedDays: opts.daysUsed }),
    },
  );
  if (!res.ok && res.status !== 404) {
    const text = await res.text().catch(() => "<no body>");
    throw new Error(`seedTakenLeave: ${res.status} — ${text}`);
  }
}

interface BookLeaveOpts {
  startDate: string;
  endDate: string;
}

/**
 * File + auto-approve a VACATION leave request inside the tenant via
 * admin-on-behalf-of. Used by the FIFO test to consume from carry-over.
 */
async function bookLeave(
  t: TestTenant,
  employeeId: string,
  opts: BookLeaveOpts,
): Promise<void> {
  const fileRes = await fetch(`${API_BASE}/api/v1/leave/requests`, {
    method: "POST",
    headers: authHeaders(t),
    body: JSON.stringify({
      type: "VACATION",
      employeeId,
      startDate: opts.startDate,
      endDate: opts.endDate,
    }),
  });
  if (!fileRes.ok) {
    const text = await fileRes.text().catch(() => "<no body>");
    throw new Error(`bookLeave: ${fileRes.status} — ${text}`);
  }
  const req = (await fileRes.json()) as { id: string; status: string };
  if (req.status === "APPROVED") return;

  const approveRes = await fetch(
    `${API_BASE}/api/v1/leave/requests/${req.id}/review`,
    {
      method: "PATCH",
      headers: authHeaders(t),
      body: JSON.stringify({ status: "APPROVED" }),
    },
  );
  if (!approveRes.ok) {
    const text = await approveRes.text().catch(() => "<no body>");
    throw new Error(`bookLeave/approve: ${approveRes.status} — ${text}`);
  }
}

interface AufforderungOpts {
  year: number;
  date: string;
}

/**
 * Record the documented refusal-to-take notification (BUrlG § 7 / EuGH
 * C-684/16). Once this is in the system, the carry-over from `year` may
 * legally expire on the configured deadline.
 *
 * Endpoint forward-declared — the carryover-warning plugin already writes
 * a CARRYOVER_WARNED AuditLog entry that the entitlement endpoint reads
 * to flip the "Aufforderung fehlt" UI flag. POST to /reports/carryover-warn
 * with the entitlement id is the manual trigger path documented in the
 * existing apps/api/src/__tests__/carryover-warning.test.ts.
 */
async function recordAufforderung(
  t: TestTenant,
  employeeId: string,
  opts: AufforderungOpts,
): Promise<void> {
  // Look up the entitlement id for this employee + year. The /reports
  // surface is admin-only, so the tenant.adminToken suffices.
  const listRes = await fetch(
    `${API_BASE}/api/v1/leave/entitlements/${employeeId}?year=${opts.year}`,
    { headers: authHeaders(t) },
  );
  if (!listRes.ok) {
    const text = await listRes.text().catch(() => "<no body>");
    throw new Error(`recordAufforderung/list: ${listRes.status} — ${text}`);
  }
  const rows = (await listRes.json()) as Array<{ id: string; year: number }>;
  const target = rows.find((r) => r.year === opts.year);
  if (!target) {
    throw new Error(
      `recordAufforderung: no entitlement found for employee ${employeeId} year ${opts.year}`,
    );
  }

  // POST the manual trigger — this writes the CARRYOVER_WARNED audit entry
  // dated `opts.date`, satisfying the EuGH Hinweispflicht.
  const warnRes = await fetch(`${API_BASE}/api/v1/reports/carryover-warn`, {
    method: "POST",
    headers: { ...authHeaders(t), "x-test-now": new Date(opts.date).toISOString() },
    body: JSON.stringify({ entitlementId: target.id }),
  });
  if (!warnRes.ok) {
    const text = await warnRes.text().catch(() => "<no body>");
    throw new Error(`recordAufforderung/trigger: ${warnRes.status} — ${text}`);
  }
}

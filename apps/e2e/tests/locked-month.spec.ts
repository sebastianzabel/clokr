/**
 * Locked-month immutability — cross-surface consistency spec.
 *
 * Per CLAUDE.md "Immutability after lock": once a month is closed
 * (`isLocked=true`), entries MUST NOT be editable or deletable — not even by
 * admins. This spec is the canonical proof that every UI surface that
 * touches time / leave / absence / schedule data for that month honors the
 * same lock contract and surfaces the same German error banner.
 *
 * Wave-1 deliverable for Phase 74. Plans 74-01 (Monatsabschluss),
 * 74-04 (Cancellation), and 74-05 (NFC) import `expectLockedMonthError`
 * from `../helpers/locked-month` and rely on the per-surface invariants
 * asserted here.
 */
import { test } from "../fixtures";
import type { TestTenant } from "../fixtures";
import {
  expectLockedMonthError,
  expectNoLockedMonthError,
} from "../helpers/locked-month";

const API_BASE = process.env.E2E_API_BASE ?? "http://localhost:4000";

interface LockedMonthSeed {
  employeeId: string;
  /** "YYYY-MM" — the locked calendar month */
  month: string;
  /** TimeEntry id inside the locked month (for edit-attempt URLs) */
  timeEntryId: string;
  /** Reopens the month and admin-approves the request in one call */
  reopenAndApprove: () => Promise<void>;
}

/**
 * Inline seeder for the locked-month scenario.
 *
 * Wave-1 design choice: this helper lives in-spec so plan 74-06 ships in a
 * single wave-1 worktree (`files_modified` stays minimal). Plan 74-01 will
 * land its own domain-specific `apps/e2e/helpers/monatsabschluss.ts` with a
 * richer surface; at that point this inline helper can be deleted and the
 * spec switched to the shared helper. The duplication is acknowledged in
 * the 74-06 plan and is intentional for wave isolation.
 */
async function seedLockedMonth(tenant: TestTenant): Promise<LockedMonthSeed> {
  const headers = {
    "content-type": "application/json",
    authorization: `Bearer ${tenant.adminToken}`,
  };

  // 1. Create an employee inside the test tenant
  const empRes = await fetch(`${API_BASE}/api/v1/employees`, {
    method: "POST",
    headers,
    body: JSON.stringify({
      firstName: "Lock",
      lastName: "Test",
      email: `lock-${Date.now()}@${tenant.tenantId}.test`,
      employeeNumber: `LK-${Date.now()}`,
      hireDate: "2024-01-01",
      role: "EMPLOYEE",
    }),
  });
  if (!empRes.ok) {
    throw new Error(`seedLockedMonth: employee create failed (${empRes.status})`);
  }
  const employee = (await empRes.json()) as { id: string };

  // 2. Pick the previous calendar month — must be in the past so it can be locked
  const now = new Date();
  const prev = new Date(now.getFullYear(), now.getMonth() - 1, 1);
  const yyyy = prev.getFullYear();
  const mm = String(prev.getMonth() + 1).padStart(2, "0");
  const month = `${yyyy}-${mm}`;

  // 3. Seed a time entry on the 15th of that month
  const entryDate = `${month}-15`;
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
  if (!entryRes.ok) {
    throw new Error(`seedLockedMonth: time-entry create failed (${entryRes.status})`);
  }
  const entry = (await entryRes.json()) as { id: string };

  // 4. Close (lock) the month — uses the canonical Monatsabschluss endpoint
  const lockRes = await fetch(`${API_BASE}/api/v1/monatsabschluss/${month}/close`, {
    method: "POST",
    headers,
    body: JSON.stringify({ employeeId: employee.id }),
  });
  if (!lockRes.ok && lockRes.status !== 409) {
    // 409 = already locked — acceptable for re-runs in KEEP_TEST_TENANTS mode
    throw new Error(`seedLockedMonth: lock failed (${lockRes.status})`);
  }

  // 5. Return a closure that reopens + admin-approves the month
  const reopenAndApprove = async (): Promise<void> => {
    const requestRes = await fetch(
      `${API_BASE}/api/v1/monatsabschluss/${month}/reopen-request`,
      {
        method: "POST",
        headers,
        body: JSON.stringify({
          employeeId: employee.id,
          reason: "E2E reopen for cross-surface symmetry test",
        }),
      },
    );
    if (!requestRes.ok) {
      throw new Error(`reopenAndApprove: request failed (${requestRes.status})`);
    }
    const request = (await requestRes.json()) as { id: string };

    const approveRes = await fetch(
      `${API_BASE}/api/v1/monatsabschluss/reopen-request/${request.id}/approve`,
      { method: "POST", headers },
    );
    if (!approveRes.ok) {
      throw new Error(`reopenAndApprove: approve failed (${approveRes.status})`);
    }
  };

  return {
    employeeId: employee.id,
    month,
    timeEntryId: entry.id,
    reopenAndApprove,
  };
}

test.describe("Locked-month immutability — cross-surface consistency", () => {
  test("time-entry surface: edit attempt on locked month shows shared error", async ({
    page,
    tenant,
  }) => {
    const { employeeId, month, timeEntryId } = await seedLockedMonth(tenant);

    await page.goto(
      `/zeiterfassung/${employeeId}/entry/${timeEntryId}/edit?month=${month}`,
    );
    await expectLockedMonthError(page, "time-entry");
  });

  test("leave surface: file leave for date inside locked month shows shared error", async ({
    page,
    tenant,
  }) => {
    const { employeeId, month } = await seedLockedMonth(tenant);
    const lockedDate = `${month}-15`;

    await page.goto(
      `/employee/${employeeId}/urlaub/neu?startDate=${lockedDate}&endDate=${lockedDate}`,
    );
    // The form should either be pre-disabled OR surface the banner on submit.
    // Click the submit button — the helper auto-retries until the banner appears.
    await page.getByTestId("leave-form-submit").click();
    await expectLockedMonthError(page, "leave");
  });

  test("absence surface: file absence for date inside locked month shows shared error", async ({
    page,
    tenant,
  }) => {
    const { employeeId, month } = await seedLockedMonth(tenant);
    const lockedDate = `${month}-15`;

    await page.goto(
      `/employee/${employeeId}/abwesenheit/neu?date=${lockedDate}`,
    );
    await page.getByTestId("absence-form-submit").click();
    await expectLockedMonthError(page, "absence");
  });

  test("schedule surface: modify shift in locked month shows shared error", async ({
    page,
    tenant,
  }) => {
    const { employeeId, month } = await seedLockedMonth(tenant);
    const lockedDate = `${month}-15`;

    await page.goto(`/admin/shifts?date=${lockedDate}&employeeId=${employeeId}`);
    // Click the shift cell for the locked day — expect banner instead of editor
    await page
      .getByTestId(`shift-cell-${lockedDate}-${employeeId}`)
      .click();
    await expectLockedMonthError(page, "schedule");
  });

  test("after reopen approval, banner disappears on every surface", async ({
    page,
    tenant,
  }) => {
    const { employeeId, month, timeEntryId, reopenAndApprove } =
      await seedLockedMonth(tenant);

    // Pre-condition: the time-entry surface is locked
    await page.goto(`/zeiterfassung/${employeeId}?month=${month}`);
    await expectLockedMonthError(page, "time-entry");

    // Reopen the month and admin-approve in one call
    await reopenAndApprove();

    // All four surfaces must now be unlocked — banner gone everywhere.
    // This is the cross-surface symmetry proof: the lock state is not
    // cached per surface, it is materialized live from the SaldoSnapshot.
    const surfaces: string[] = [
      `/zeiterfassung/${employeeId}/entry/${timeEntryId}/edit`,
      `/employee/${employeeId}/urlaub/neu?startDate=${month}-15&endDate=${month}-15`,
      `/employee/${employeeId}/abwesenheit/neu?date=${month}-15`,
      `/admin/shifts?date=${month}-15&employeeId=${employeeId}`,
    ];

    for (const path of surfaces) {
      await page.goto(path);
      await expectNoLockedMonthError(page);
    }
  });
});

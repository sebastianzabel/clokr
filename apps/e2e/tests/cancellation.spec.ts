/**
 * Leave cancellation flow — multi-actor E2E spec.
 *
 * Wave-2 deliverable for Phase 74-04. Covers the full Leave Cancellation
 * Flow from CLAUDE.md:
 *
 *   1. APPROVED → request cancellation → status = CANCELLATION_REQUESTED
 *   2. Leave remains active (calendar + saldo) until cancellation reviewed
 *   3. Time entries during this window: allowed but `isInvalid: true`
 *   4. DIFFERENT manager approves cancellation → CANCELLED + entries
 *      auto-revalidated (this is the security-critical multi-actor gate)
 *   5. Cancellation rejected → reverts to APPROVED, entries stay invalid
 *
 * The self-approval block test is the critical security gate — it MUST
 * fail loudly if the API ever drops the different-manager check. Asserts
 * the contract at BOTH layers:
 *   - API: 403 Forbidden + German error message
 *   - UI: status badge unchanged (still CANCELLATION_REQUESTED)
 *
 * Depends on:
 *   - Phase 73-01 + 73-02: tenant fixture (../fixtures, TestTenant)
 *   - Phase 73-04: data-testid migration for Urlaub + LeaveForm + ApprovalFlow
 *     (leave-status-badge, leave-audit-trail, time-entry-row-*-invalid-badge)
 */
import { test, expect } from "../fixtures";
import {
  createManager,
  seedApprovedLeave,
  requestCancellation,
  reviewCancellation,
  createInvalidTimeEntryDuringCancellation,
} from "../helpers/leave-cancellation";

test.describe("Leave cancellation flow", () => {
  test("happy path: APPROVED → request cancellation → different manager approves → CANCELLED", async ({
    page,
    tenant,
  }) => {
    const managerA = await createManager(tenant, { email: `managerA-${Date.now()}@${tenant.tenantId}.test` });
    const managerB = await createManager(tenant, { email: `managerB-${Date.now()}@${tenant.tenantId}.test` });

    const { leaveRequestId } = await seedApprovedLeave(tenant, {
      startDate: "2026-08-10",
      endDate: "2026-08-14",
    });

    // Manager A requests cancellation
    await requestCancellation(tenant, leaveRequestId, managerA.token);

    // Manager B (different manager) reviews + approves → CANCELLED
    const result = await reviewCancellation(tenant, leaveRequestId, "APPROVED", managerB.token);
    expect(result.status).toBe(200);

    // Verify final state via UI — status badge shows "Storniert", audit trail
    // surfaces both managers (Phase 73-04 data-testid contract).
    await page.goto(`/admin/urlaub/${leaveRequestId}`);
    await expect(page.getByTestId("leave-status-badge")).toContainText("Storniert");
    await expect(page.getByTestId("leave-audit-trail")).toContainText(managerA.email);
    await expect(page.getByTestId("leave-audit-trail")).toContainText(managerB.email);
  });

  test("SELF-APPROVAL BLOCKED: Manager A requests, Manager A attempts to approve → 403", async ({
    page,
    tenant,
  }) => {
    const managerA = await createManager(tenant);

    const { leaveRequestId } = await seedApprovedLeave(tenant, {
      startDate: "2026-08-10",
      endDate: "2026-08-14",
    });

    await requestCancellation(tenant, leaveRequestId, managerA.token);

    // Manager A tries to approve their own cancellation request → 403
    const result = await reviewCancellation(tenant, leaveRequestId, "APPROVED", managerA.token);
    expect(result.status).toBe(403);
    // German error must surface — match the documented messages
    // ("Selbstgenehmigung" / "self-approval" / "anderer Manager").
    expect(JSON.stringify(result.body)).toMatch(
      /Selbstgenehmigung|selbst genehmigt|self-approval|anderer Manager/i,
    );

    // Verify status unchanged via UI (still CANCELLATION_REQUESTED, NOT CANCELLED).
    // This is the cross-layer proof: API rejection must be reflected in UI state
    // so an admin scrolling past the API error cannot accidentally believe the
    // cancellation went through.
    await page.goto(`/admin/urlaub/${leaveRequestId}`);
    await expect(page.getByTestId("leave-status-badge")).toContainText("Stornierung beantragt");
  });

  test("time entries created during CANCELLATION_REQUESTED are marked isInvalid", async ({
    page,
    tenant,
  }) => {
    const managerA = await createManager(tenant);
    const { leaveRequestId, employeeId } = await seedApprovedLeave(tenant, {
      startDate: "2026-08-10",
      endDate: "2026-08-14",
    });

    await requestCancellation(tenant, leaveRequestId, managerA.token);

    // POST /api/v1/time-entries inside the cancellation window — must succeed
    // with isInvalid=true per CLAUDE.md ArbZG §8 BUrlG.
    const { timeEntryId, isInvalid, invalidReason } =
      await createInvalidTimeEntryDuringCancellation(tenant, employeeId, "2026-08-12");
    expect(isInvalid).toBe(true);
    expect(invalidReason).toBe("Urlaubsstornierung ausstehend");

    // Verify the UI surfaces the invalid state — the badge + tooltip prove
    // that the calendar wiring picks up the isInvalid flag.
    await page.goto(`/zeiterfassung/${employeeId}?month=2026-08`);
    const badge = page.getByTestId(`time-entry-row-${timeEntryId}-invalid-badge`);
    await expect(badge).toBeVisible();
    await expect(badge).toHaveAttribute("title", /Urlaubsstornierung ausstehend/);
  });

  test("CANCELLATION approved → invalid time entries auto-revalidated", async ({
    page,
    tenant,
  }) => {
    const managerA = await createManager(tenant);
    const managerB = await createManager(tenant);
    const { leaveRequestId, employeeId } = await seedApprovedLeave(tenant, {
      startDate: "2026-08-10",
      endDate: "2026-08-14",
    });

    await requestCancellation(tenant, leaveRequestId, managerA.token);
    const { timeEntryId } = await createInvalidTimeEntryDuringCancellation(
      tenant,
      employeeId,
      "2026-08-12",
    );

    // Manager B approves cancellation → API auto-revalidates invalid entries
    // (leave.ts line ~590: updateMany clears isInvalid + invalidReason).
    const result = await reviewCancellation(tenant, leaveRequestId, "APPROVED", managerB.token);
    expect(result.status).toBe(200);

    // The previously-invalid entry must now render as valid — proof that the
    // bidirectional API → DB → UI flow holds.
    await page.goto(`/zeiterfassung/${employeeId}?month=2026-08`);
    await expect(
      page.getByTestId(`time-entry-row-${timeEntryId}-invalid-badge`),
    ).toBeHidden();
    await expect(page.getByTestId(`time-entry-row-${timeEntryId}`)).toHaveAttribute(
      "data-state",
      "valid",
    );
  });

  test("CANCELLATION rejected → invalid entries stay invalid + leave reverts to APPROVED", async ({
    page,
    tenant,
  }) => {
    const managerA = await createManager(tenant);
    const managerB = await createManager(tenant);
    const { leaveRequestId, employeeId } = await seedApprovedLeave(tenant, {
      startDate: "2026-08-10",
      endDate: "2026-08-14",
    });

    await requestCancellation(tenant, leaveRequestId, managerA.token);
    const { timeEntryId } = await createInvalidTimeEntryDuringCancellation(
      tenant,
      employeeId,
      "2026-08-12",
    );

    // Manager B rejects cancellation → leave.ts line ~651: status reverts to APPROVED,
    // time entries stay isInvalid (manager must manually handle).
    const result = await reviewCancellation(tenant, leaveRequestId, "REJECTED", managerB.token);
    expect(result.status).toBe(200);

    // Leave reverts to APPROVED — visible in status badge
    await page.goto(`/admin/urlaub/${leaveRequestId}`);
    await expect(page.getByTestId("leave-status-badge")).toContainText("Genehmigt");

    // Time entry stays invalid — the rejection path explicitly does NOT
    // revalidate. Per CLAUDE.md: "manager can manually handle".
    await page.goto(`/zeiterfassung/${employeeId}?month=2026-08`);
    await expect(
      page.getByTestId(`time-entry-row-${timeEntryId}-invalid-badge`),
    ).toBeVisible();
  });
});

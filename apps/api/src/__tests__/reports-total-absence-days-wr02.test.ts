/**
 * reports-total-absence-days-wr02.test.ts
 *
 * WR-02 (451-REVIEW.md): `computeEmployeeSummary`'s `totalAbsenceDays` (composition/reports.ts)
 * sums each non-sick `LeaveTypeCode`'s own §9-netted `netDays` independently, with no cross-type
 * same-day dedup (451-02-SUMMARY.md, Deviation #2). The review asked for this to be re-verified
 * specifically against a SICK+non-sick overlap — the module's own comment two paragraphs above
 * `computeEmployeeSummary` calls that combination "the normal case, not the exception" since § 9
 * BUrlG (R1).
 *
 * This test exercises exactly that combination through the REAL create/approve/confirm API
 * (section9-credit.test.ts's own fixture pattern) and proves `totalAbsenceDays` never
 * double-counts a day shared between an APPROVED VACATION request and an overlapping APPROVED
 * SICK request, in BOTH states:
 *   - AU_PENDING (credit created, not yet confirmed): VACATION's own `netDays` is not yet §9-net
 *     (section9CreditDays only counts CONFIRMED credits), so `totalAbsenceDays` still equals the
 *     full VACATION count. SICK's days are tracked separately (`sickDays`), never added into
 *     `totalAbsenceDays` — `isSickLeaveTypeCode` excludes every sick code from that sum
 *     (composition/reports.ts, `computeEmployeeSummary`). One non-sick code (VACATION)
 *     contributes the shared day; SICK contributes 0. No double count.
 *   - CONFIRMED: VACATION's `netDays` now subtracts the credited days (`leaveDaysByCodeWithin`'s
 *     §9 netting, Issue #451 D-02), so `totalAbsenceDays` drops by exactly the credited days —
 *     still equal to `vacationDays` (the only non-sick code involved), never double-counted.
 *
 * leave.ts's create-time overlap guard (`blockingOverlap`) structurally prevents the ONE
 * combination that WOULD double-count `totalAbsenceDays` — two DIFFERENT NON-SICK codes
 * overlapping the same day (`if (!isSickRequest) return true` blocks every non-sick-vs-anything
 * overlap outright) — so no cross-type dedup pass is reinstated here: the Tier 2 Phase 104 dedup
 * this phase (Issue #451 D-02) replaced guarded against a case the create-time guard already
 * makes unreachable for sick, and never happens for non-sick/non-sick at all.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import {
  getTestApp,
  closeTestApp,
  seedTestData,
  cleanupTestData,
  seedEntitlementYears,
} from "./setup";
import type { FastifyInstance } from "fastify";

type MonthlyReportRow = {
  employeeId: string;
  vacationDays: number;
  sickDays: number;
  totalAbsenceDays: number;
};

describe("WR-02 (451-REVIEW.md) — totalAbsenceDays never double-counts a SICK+VACATION overlap day", () => {
  let app: FastifyInstance;
  let data: Awaited<ReturnType<typeof seedTestData>>;

  beforeAll(async () => {
    app = await getTestApp();
    data = await seedTestData(app, "wr02tad");
    await seedEntitlementYears(app, {
      employeeId: data.employee.id,
      leaveTypeId: data.vacationType.id,
      years: [2026],
    });
  });

  afterAll(async () => {
    try {
      await app.prisma.section9Credit.deleteMany({ where: { employeeId: data.employee.id } });
      await cleanupTestData(app, data.tenant.id);
    } catch (err) {
      console.error("WR-02 reports-total-absence-days cleanup failed:", err);
    }
    await closeTestApp();
  });

  async function createRequest(payload: Record<string, unknown>) {
    return app.inject({
      method: "POST",
      url: "/api/v1/leave/requests",
      headers: { authorization: `Bearer ${data.empToken}` },
      payload,
    });
  }

  async function approve(id: string) {
    return app.inject({
      method: "PATCH",
      url: `/api/v1/leave/requests/${id}/review`,
      headers: { authorization: `Bearer ${data.adminToken}` },
      payload: { status: "APPROVED" },
    });
  }

  async function confirmCredit(id: string, body: Record<string, unknown>) {
    return app.inject({
      method: "POST",
      url: `/api/v1/leave/section9/${id}/confirm`,
      headers: { authorization: `Bearer ${data.adminToken}` },
      payload: body,
    });
  }

  async function getMonthlyRow(year: number, month: number): Promise<MonthlyReportRow> {
    const res = await app.inject({
      method: "GET",
      url: `/api/v1/reports/monthly?employeeId=${data.employee.id}&year=${year}&month=${month}`,
      headers: { authorization: `Bearer ${data.adminToken}` },
    });
    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body) as { rows: MonthlyReportRow[] };
    return body.rows.find((r) => r.employeeId === data.employee.id)!;
  }

  it("AU_PENDING (not yet confirmed): totalAbsenceDays equals the full VACATION count — SICK contributes 0, no double count", async () => {
    // Mon 02.02.2026 - Fri 06.02.2026, NIEDERSACHSEN has no holiday that week — 5 workdays.
    const vac = await createRequest({
      type: "VACATION",
      startDate: "2026-02-02",
      endDate: "2026-02-06",
    });
    expect(vac.statusCode).toBe(201);
    const vacId = JSON.parse(vac.body).id as string;
    expect((await approve(vacId)).statusCode).toBe(200);

    // SICK while on vacation (§ 9 BUrlG, "the normal case") — Tue+Wed, 2 of the 5 vacation days.
    const sick = await createRequest({
      type: "SICK",
      startDate: "2026-02-03",
      endDate: "2026-02-04",
    });
    expect(sick.statusCode).toBe(201);
    const sickId = JSON.parse(sick.body).id as string;
    expect((await approve(sickId)).statusCode).toBe(200);

    const credit = await app.prisma.section9Credit.findFirstOrThrow({
      where: { sickRequestId: sickId },
    });
    expect(credit.status).toBe("AU_PENDING");

    const row = await getMonthlyRow(2026, 2);
    expect(row.vacationDays, "VACATION not yet §9-netted (credit still AU_PENDING)").toBe(5);
    expect(row.sickDays, "the two SICK days, tracked separately").toBe(2);
    // The actual WR-02 assertion: totalAbsenceDays must equal vacationDays exactly — not
    // vacationDays + sickDays (7), which would be the double-count this test guards against.
    expect(row.totalAbsenceDays, "no double count: equals vacationDays, SICK excluded").toBe(5);
  });

  it("CONFIRMED: totalAbsenceDays drops by the credited days together with vacationDays — still no double count", async () => {
    const vac = await createRequest({
      type: "VACATION",
      startDate: "2026-03-02",
      endDate: "2026-03-06",
    });
    expect(vac.statusCode).toBe(201);
    const vacId = JSON.parse(vac.body).id as string;
    expect((await approve(vacId)).statusCode).toBe(200);

    const sick = await createRequest({
      type: "SICK",
      startDate: "2026-03-03",
      endDate: "2026-03-04",
    });
    expect(sick.statusCode).toBe(201);
    const sickId = JSON.parse(sick.body).id as string;
    expect((await approve(sickId)).statusCode).toBe(200);

    const credit = await app.prisma.section9Credit.findFirstOrThrow({
      where: { sickRequestId: sickId },
    });

    const confirmRes = await confirmCredit(credit.id, {
      attestSource: "EAU",
      attestValidFrom: "2026-03-03",
      attestValidTo: "2026-03-04",
      reason: "AU für die zwei Krankheitstage eingereicht",
    });
    expect(confirmRes.statusCode).toBe(200);

    const row = await getMonthlyRow(2026, 3);
    // 5 vacation days minus the 2 §9-credited days = 3; totalAbsenceDays must move WITH
    // vacationDays, not stay at the pre-credit 5 (which would mean SICK's days leaked in
    // separately) — both read 3.
    expect(row.vacationDays).toBe(3);
    expect(row.sickDays, "SICK days unaffected by the credit, now attested").toBe(2);
    expect(row.totalAbsenceDays, "moves together with vacationDays — no double count").toBe(3);
  });
});

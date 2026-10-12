/**
 * Issue #84 (D-14) — neutrality pin for the sick-day / § 9 arithmetic of `GET /reports/monthly`.
 *
 * That arithmetic used to live privately in `composition/reports.ts` (`computeEmployeeSummary`)
 * and moves into the absence context as `sickLeaveDayCounts()`. The literal below was captured on
 * the UNCHANGED tree (commit a0258a8d) BEFORE the move, so a later failure means the report's
 * payroll-relevant figures changed: investigate the production change, never re-capture it.
 *
 * Fixed clock: 2026-07-15T10:00:00Z (June 2026 is an open past month). Only `Date` is faked.
 *
 * Fixture on one employee for June 2026 (sick leave counts calendar days, weekends included):
 *   - SICK 03.-05.06. APPROVED, no attest                         -> 3 without
 *   - SICK 10.06. half day APPROVED                                -> 0.5 without
 *   - SICK 29.05.-02.06. APPROVED (cross-month, June part)         -> 2 without
 *   - SICK 12.-14.06. APPROVED (Fri-Sun)                           -> 3 without
 *   - SICK_CHILD 15.-16.06. APPROVED, attest only on 16.06.        -> 1 with, 1 without
 *   - SICK 22.06. CANCELLATION_REQUESTED (still active leave)      -> 1 without
 *   - SICK 24.06. PENDING and SICK 25.06. soft-deleted             -> not counted
 *   - VACATION 08.-09.06. APPROVED + SICK 09.06. APPROVED with a CONFIRMED § 9 credit on 09.06.
 *                                                                  -> 1 day moves without -> with
 */
import { describe, it, expect, beforeAll, afterAll, vi } from "vitest";
import type { FastifyInstance } from "fastify";
import {
  getTestApp,
  closeTestApp,
  seedTestData,
  cleanupTestData,
  reissueTokenNow,
} from "../../__tests__/setup";
import { leaveTypeFields } from "../../contexts/absence/leave-type";

const FAKE_NOW = new Date("2026-07-15T10:00:00Z");

const EXPECTED = {
  employeeName: "Max Test",
  workedHours: 0,
  shouldHours: 84,
  overtimeHours: -84,
  overtimeConfirmed: false,
  balanceAdjustmentHours: 0,
  sickDays: 12.5,
  sickDaysWithAttest: 2,
  sickDaysWithoutAttest: 10.5,
  vacationDays: 1,
  overtimeCompDays: 0,
  specialLeaveDays: 0,
  educationDays: 0,
  unpaidDays: 0,
  maternityDays: 0,
  parentalDays: 0,
  totalAbsenceDays: 1,
  section9DaysThisMonth: 1,
};

describe("Issue #84 — /reports/monthly frozen pre-84 sick and § 9 figures", () => {
  let app: FastifyInstance;
  let d: Awaited<ReturnType<typeof seedTestData>>;

  function day(date: string) {
    return new Date(`${date}T00:00:00Z`);
  }

  beforeAll(async () => {
    app = await getTestApp();
    d = await seedTestData(app, "rm84f");
    const prisma = app.prisma;

    const vacationType = await prisma.leaveType.findFirstOrThrow({
      where: { tenantId: d.tenant.id, code: "VACATION" },
    });
    const sickType = await prisma.leaveType.create({
      data: { tenantId: d.tenant.id, ...leaveTypeFields("SICK"), color: "#EF4444" },
    });
    const sickChildType = await prisma.leaveType.create({
      data: { tenantId: d.tenant.id, ...leaveTypeFields("SICK_CHILD"), color: "#F97316" },
    });

    const leave = (
      leaveTypeId: string,
      start: string,
      end: string,
      days: number,
      extra: Record<string, unknown> = {},
    ) =>
      prisma.leaveRequest.create({
        data: {
          employeeId: d.employee.id,
          leaveTypeId,
          startDate: day(start),
          endDate: day(end),
          days,
          status: "APPROVED",
          reviewedBy: d.adminUser.id,
          reviewedAt: new Date(),
          ...extra,
        } as never,
      });

    await leave(sickType.id, "2026-06-03", "2026-06-05", 3);
    await leave(sickType.id, "2026-06-10", "2026-06-10", 0.5, { halfDay: true });
    await leave(sickType.id, "2026-05-29", "2026-06-02", 3);
    await leave(sickType.id, "2026-06-12", "2026-06-14", 1);
    await leave(sickChildType.id, "2026-06-15", "2026-06-16", 2, {
      attestPresent: true,
      attestValidFrom: day("2026-06-16"),
      attestValidTo: day("2026-06-16"),
    });
    await leave(sickType.id, "2026-06-22", "2026-06-22", 1, { status: "CANCELLATION_REQUESTED" });
    await leave(sickType.id, "2026-06-24", "2026-06-24", 1, {
      status: "PENDING",
      reviewedBy: null,
      reviewedAt: null,
    });
    await leave(sickType.id, "2026-06-25", "2026-06-25", 1, { deletedAt: new Date() });

    const vacation = await leave(vacationType.id, "2026-06-08", "2026-06-09", 2);
    const sick = await leave(sickType.id, "2026-06-09", "2026-06-09", 1);
    await prisma.section9Credit.create({
      data: {
        employeeId: d.employee.id,
        sickRequestId: sick.id,
        vacationRequestId: vacation.id,
        overlapStart: day("2026-06-09"),
        overlapEnd: day("2026-06-09"),
        status: "CONFIRMED",
        creditedStart: day("2026-06-09"),
        creditedEnd: day("2026-06-09"),
        creditedDays: 1,
        attestSource: "EAU",
        attestValidFrom: day("2026-06-09"),
        attestValidTo: day("2026-06-09"),
        reason: "frozen pin fixture rm84f",
        reviewedBy: d.adminUser.id,
        reviewedAt: new Date(),
      },
    });
  });

  afterAll(async () => {
    try {
      await cleanupTestData(app, d.tenant.id);
    } catch (err) {
      console.error("reports-monthly-frozen-84 cleanup failed:", err);
    }
    await closeTestApp();
  });

  it("answers the frozen pre-84 literal for ?year=2026&month=6", async () => {
    vi.useFakeTimers({ now: FAKE_NOW, toFake: ["Date"] });
    let body: { rows: Array<Record<string, unknown>>; section9Note?: string };
    try {
      const res = await app.inject({
        method: "GET",
        url: "/api/v1/reports/monthly?year=2026&month=6",
        headers: { authorization: `Bearer ${reissueTokenNow(app, d.adminToken)}` },
      });
      expect(res.statusCode).toBe(200);
      body = JSON.parse(res.body);
    } finally {
      vi.useRealTimers();
    }

    const row = body.rows.find((r) => r.employeeId === d.employee.id);
    expect(row).toBeDefined();
    // The employee number embeds a per-run timestamp and the id is a per-run uuid.
    const figures = Object.fromEntries(
      Object.entries(row ?? {}).filter(([k]) => k !== "employeeId" && k !== "employeeNumber"),
    );
    expect(figures).toEqual(EXPECTED);
    expect(typeof body.section9Note).toBe("string");
  });
});

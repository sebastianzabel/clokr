/**
 * Issue #448 (D-04, owner decision 01.10.2026 + implementation decisions 02.10.2026) — a
 * Berufsschultag that appears LATER over already-booked vacation books the vacation day back:
 * atomically, audited, notified. A closed month changes nothing and only raises a
 * correction-booking message.
 *
 * Task 1: direct calls into `correctLeaveForNewVocationalSchoolDay` /
 * `flagLockedVocationalSchoolLeaveOverlaps`, each wrapped in `app.prisma.$transaction` the way
 * the real write paths (generator, manual-insert) will in Task 2.
 * Task 2 (appended below): the same behaviour through the real HTTP write paths.
 *
 * Every date is a fixed 2027/2028 calendar literal — the same NIEDERSACHSEN / no-holiday weeks
 * leave-bs-day-448.test.ts (plan 01) already established as safe.
 */
import type { FastifyInstance } from "fastify";
import { Prisma } from "@clokr/db";
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import bcrypt from "bcryptjs";
import {
  getTestApp,
  seedTestData,
  seedEntitlementYears,
  cleanupTestData,
  closeTestApp,
} from "./setup";
import { leaveTypeFields } from "../contexts/absence/leave-type";
import { monthRangeUtc } from "../contexts/working-time-account";
import {
  correctLeaveForNewVocationalSchoolDay,
  flagLockedVocationalSchoolLeaveOverlaps,
  BS_LEAVE_CORRECTION_REASON,
  LEAVE_CORRECTED_VOCATIONAL_SCHOOL,
  LEAVE_CORRECTION_NEEDED_VOCATIONAL_SCHOOL,
} from "../contexts/absence/bs-leave-correction";

describe("Issue #448 (D-04) — Berufsschultag über bestehendem Urlaub korrigiert Buchung", () => {
  let app: FastifyInstance;
  let data: Awaited<ReturnType<typeof seedTestData>>;
  let sbEmployeeId: string;
  let sbUserId: string;
  let sickTypeId: string;

  beforeAll(async () => {
    app = await getTestApp();
    data = await seedTestData(app, "bscorr448");
    await app.prisma.employee.update({
      where: { id: data.employee.id },
      data: { classification: "AZUBI", birthDate: new Date("2010-06-01") },
    });
    await seedEntitlementYears(app, {
      employeeId: data.employee.id,
      leaveTypeId: data.vacationType.id,
      years: [2027, 2028],
    });

    // SHIFT_BASED AZUBI, contractWorkDaysPerWeek 5 — same shape as leave-bs-day-448.test.ts.
    const passwordHash = await bcrypt.hash("test1234", 10);
    const sbUser = await app.prisma.user.create({
      data: {
        email: `bscorr448-sb-${Date.now()}@test.de`,
        passwordHash,
        role: "EMPLOYEE",
        isActive: true,
      },
    });
    sbUserId = sbUser.id;
    const sbEmployee = await app.prisma.employee.create({
      data: {
        tenantId: data.tenant.id,
        userId: sbUser.id,
        employeeNumber: `SBC448-${Date.now()}`,
        firstName: "Azubi",
        lastName: "ShiftBasedCorr",
        hireDate: new Date("2026-01-01"),
        classification: "AZUBI",
        birthDate: new Date("2010-06-01"),
      },
    });
    sbEmployeeId = sbEmployee.id;
    await app.prisma.workSchedule.create({
      data: {
        employeeId: sbEmployeeId,
        type: "SHIFT_BASED",
        weeklyHours: 40,
        contractWorkDaysPerWeek: 5,
        workDays: [1, 2, 3, 4, 5],
        validFrom: new Date("2026-01-01"),
      },
    });
    await app.prisma.overtimeAccount.create({
      data: { employeeId: sbEmployeeId, balanceHours: 0 },
    });
    await seedEntitlementYears(app, {
      employeeId: sbEmployeeId,
      leaveTypeId: data.vacationType.id,
      years: [2027, 2028],
    });

    const sickType = await app.prisma.leaveType.create({
      data: { tenantId: data.tenant.id, ...leaveTypeFields("SICK") },
    });
    sickTypeId = sickType.id;
  });

  afterAll(async () => {
    try {
      await cleanupTestData(app, data.tenant.id);
    } catch (err) {
      console.error("Test cleanup failed:", err);
    }
    await closeTestApp();
  });

  // ── Fixture helpers ──────────────────────────────────────────────────────────────────────

  function mkDate(iso: string): Date {
    return new Date(`${iso}T00:00:00.000Z`);
  }

  async function createBsAbsenceTx(
    tx: Prisma.TransactionClient,
    employeeId: string,
    isoDate: string,
    source: "PATTERN" | "MANUAL" = "PATTERN",
  ) {
    return tx.absence.create({
      data: {
        employeeId,
        type: "VOCATIONAL_SCHOOL",
        source,
        startDate: mkDate(isoDate),
        endDate: mkDate(isoDate),
        days: 1,
        halfDay: false,
        createdBy: "system",
      },
    });
  }

  async function createLeaveRequest(opts: {
    employeeId: string;
    leaveTypeId: string;
    start: string;
    end: string;
    days: number;
    status: "PENDING" | "APPROVED" | "CANCELLATION_REQUESTED";
    reviewedBy?: string | null;
  }) {
    return app.prisma.leaveRequest.create({
      data: {
        employeeId: opts.employeeId,
        leaveTypeId: opts.leaveTypeId,
        startDate: mkDate(opts.start),
        endDate: mkDate(opts.end),
        days: opts.days,
        halfDay: false,
        status: opts.status,
        reviewedBy: opts.reviewedBy ?? null,
      },
    });
  }

  async function bookEntitlement(
    employeeId: string,
    leaveTypeId: string,
    year: number,
    usedDays: number,
  ) {
    await app.prisma.leaveEntitlement.update({
      where: { employeeId_leaveTypeId_year: { employeeId, leaveTypeId, year } },
      data: { usedDays },
    });
  }

  async function getNotifications(requestId: string) {
    return app.prisma.notification.findMany({
      where: { relatedType: "LeaveRequest", relatedId: requestId },
    });
  }

  async function getCorrectionAudit(requestId: string) {
    return app.prisma.auditLog.findFirst({
      where: { action: "LEAVE_CORRECTED", entity: "LeaveRequest", entityId: requestId },
      orderBy: { createdAt: "desc" },
    });
  }

  // ── Task 1: direct calls ─────────────────────────────────────────────────────────────────

  it("FIXED AZUBI, APPROVED: BS Tuesday re-prices 5 -> 4, entitlement -1, LEAVE_CORRECTED audit, Azubi + approver notified", async () => {
    const request = await createLeaveRequest({
      employeeId: data.employee.id,
      leaveTypeId: data.vacationType.id,
      start: "2027-03-08",
      end: "2027-03-12",
      days: 5,
      status: "APPROVED",
      reviewedBy: data.adminUser.id,
    });
    await bookEntitlement(data.employee.id, data.vacationType.id, 2027, 5);

    const result = await app.prisma.$transaction(async (tx) => {
      await createBsAbsenceTx(tx, data.employee.id, "2027-03-09");
      return correctLeaveForNewVocationalSchoolDay(tx, app.audit, {
        tenantId: data.tenant.id,
        employeeId: data.employee.id,
        date: mkDate("2027-03-09"),
        trigger: "PATTERN",
      });
    });
    expect(result.corrected).toEqual([request.id]);
    expect(result.flagged).toEqual([]);

    const updated = await app.prisma.leaveRequest.findUniqueOrThrow({ where: { id: request.id } });
    expect(Number(updated.days)).toBe(4);

    const entitlement = await app.prisma.leaveEntitlement.findUniqueOrThrow({
      where: {
        employeeId_leaveTypeId_year: {
          employeeId: data.employee.id,
          leaveTypeId: data.vacationType.id,
          year: 2027,
        },
      },
    });
    expect(Number(entitlement.usedDays)).toBe(4);

    const audit = await getCorrectionAudit(request.id);
    expect(audit).toBeTruthy();
    const newValue = audit!.newValue as Record<string, unknown>;
    expect(newValue.auditReason).toBe(BS_LEAVE_CORRECTION_REASON);
    expect(newValue.origin).toBe("SYSTEM");
    expect(newValue.trigger).toBe("PATTERN");
    expect(newValue.vocationalSchoolDate).toBe("2027-03-09");

    const notifications = await getNotifications(request.id);
    expect(notifications).toHaveLength(2);
    const recipientIds = notifications.map((n) => n.userId).sort();
    expect(recipientIds).toEqual([data.adminUser.id, data.empUser.id].sort());
    for (const n of notifications) expect(n.type).toBe(LEAVE_CORRECTED_VOCATIONAL_SCHOOL);
  });

  it("CANCELLATION_REQUESTED: same booking result as APPROVED", async () => {
    const request = await createLeaveRequest({
      employeeId: data.employee.id,
      leaveTypeId: data.vacationType.id,
      start: "2027-03-15",
      end: "2027-03-19",
      days: 5,
      status: "CANCELLATION_REQUESTED",
      reviewedBy: data.adminUser.id,
    });
    await bookEntitlement(data.employee.id, data.vacationType.id, 2027, 5);

    await app.prisma.$transaction(async (tx) => {
      await createBsAbsenceTx(tx, data.employee.id, "2027-03-16");
      return correctLeaveForNewVocationalSchoolDay(tx, app.audit, {
        tenantId: data.tenant.id,
        employeeId: data.employee.id,
        date: mkDate("2027-03-16"),
        trigger: "PATTERN",
      });
    });

    const updated = await app.prisma.leaveRequest.findUniqueOrThrow({ where: { id: request.id } });
    expect(Number(updated.days)).toBe(4);
    const entitlement = await app.prisma.leaveEntitlement.findUniqueOrThrow({
      where: {
        employeeId_leaveTypeId_year: {
          employeeId: data.employee.id,
          leaveTypeId: data.vacationType.id,
          year: 2027,
        },
      },
    });
    expect(Number(entitlement.usedDays)).toBe(4);
  });

  it("PENDING: days 5 -> 4, entitlement untouched, only the Azubi is notified", async () => {
    const request = await createLeaveRequest({
      employeeId: data.employee.id,
      leaveTypeId: data.vacationType.id,
      start: "2027-02-08",
      end: "2027-02-12",
      days: 5,
      status: "PENDING",
      reviewedBy: null,
    });
    // No pre-existing entitlement booking for a PENDING request.
    await bookEntitlement(data.employee.id, data.vacationType.id, 2027, 0);

    await app.prisma.$transaction(async (tx) => {
      await createBsAbsenceTx(tx, data.employee.id, "2027-02-09");
      return correctLeaveForNewVocationalSchoolDay(tx, app.audit, {
        tenantId: data.tenant.id,
        employeeId: data.employee.id,
        date: mkDate("2027-02-09"),
        trigger: "MANUAL",
        actorUserId: data.adminUser.id,
      });
    });

    const updated = await app.prisma.leaveRequest.findUniqueOrThrow({ where: { id: request.id } });
    expect(Number(updated.days)).toBe(4);
    const entitlement = await app.prisma.leaveEntitlement.findUniqueOrThrow({
      where: {
        employeeId_leaveTypeId_year: {
          employeeId: data.employee.id,
          leaveTypeId: data.vacationType.id,
          year: 2027,
        },
      },
    });
    expect(Number(entitlement.usedDays)).toBe(0); // never booked, still untouched

    const audit = await getCorrectionAudit(request.id);
    expect((audit!.newValue as Record<string, unknown>).origin).toBeUndefined(); // actor present

    const notifications = await getNotifications(request.id);
    expect(notifications).toHaveLength(1);
    expect(notifications[0].userId).toBe(data.empUser.id);
  });

  it("SHIFT_BASED AZUBI (contract 5), APPROVED Mo-Fr: 5 -> 4 via the request-mode price", async () => {
    const request = await createLeaveRequest({
      employeeId: sbEmployeeId,
      leaveTypeId: data.vacationType.id,
      start: "2027-04-05",
      end: "2027-04-09",
      days: 5,
      status: "APPROVED",
      reviewedBy: data.adminUser.id,
    });
    await bookEntitlement(sbEmployeeId, data.vacationType.id, 2027, 5);

    await app.prisma.$transaction(async (tx) => {
      await createBsAbsenceTx(tx, sbEmployeeId, "2027-04-06");
      return correctLeaveForNewVocationalSchoolDay(tx, app.audit, {
        tenantId: data.tenant.id,
        employeeId: sbEmployeeId,
        date: mkDate("2027-04-06"),
        trigger: "PATTERN",
      });
    });

    const updated = await app.prisma.leaveRequest.findUniqueOrThrow({ where: { id: request.id } });
    expect(Number(updated.days)).toBe(4);
  });

  it("SICK request over the date: untouched (not VACATION)", async () => {
    const request = await createLeaveRequest({
      employeeId: data.employee.id,
      leaveTypeId: sickTypeId,
      start: "2027-04-12",
      end: "2027-04-16",
      days: 5,
      status: "APPROVED",
      reviewedBy: data.adminUser.id,
    });

    const result = await app.prisma.$transaction(async (tx) => {
      await createBsAbsenceTx(tx, data.employee.id, "2027-04-13");
      return correctLeaveForNewVocationalSchoolDay(tx, app.audit, {
        tenantId: data.tenant.id,
        employeeId: data.employee.id,
        date: mkDate("2027-04-13"),
        trigger: "PATTERN",
      });
    });
    expect(result.corrected).toEqual([]);
    expect(result.flagged).toEqual([]);

    const updated = await app.prisma.leaveRequest.findUniqueOrThrow({ where: { id: request.id } });
    expect(Number(updated.days)).toBe(5);
    expect(await getNotifications(request.id)).toHaveLength(0);
  });

  it("second call for the same date: idempotent — no write, no audit, no notification", async () => {
    const request = await createLeaveRequest({
      employeeId: data.employee.id,
      leaveTypeId: data.vacationType.id,
      start: "2027-04-19",
      end: "2027-04-23",
      days: 5,
      status: "APPROVED",
      reviewedBy: data.adminUser.id,
    });
    await bookEntitlement(data.employee.id, data.vacationType.id, 2027, 5);

    const run = () =>
      app.prisma.$transaction(async (tx) =>
        correctLeaveForNewVocationalSchoolDay(tx, app.audit, {
          tenantId: data.tenant.id,
          employeeId: data.employee.id,
          date: mkDate("2027-04-20"),
          trigger: "PATTERN",
        }),
      );

    await app.prisma.$transaction(async (tx) =>
      createBsAbsenceTx(tx, data.employee.id, "2027-04-20"),
    );
    const first = await run();
    expect(first.corrected).toEqual([request.id]);

    const second = await run();
    expect(second.corrected).toEqual([]);
    expect(second.flagged).toEqual([]);

    const notifications = await getNotifications(request.id);
    expect(notifications).toHaveLength(2); // from the FIRST call only
  });

  it("reviewedBy inactive: approver notification falls back to the Stammsalon-scoped holders", async () => {
    const inactiveUser = await app.prisma.user.create({
      data: {
        email: `bscorr448-inactive-${Date.now()}@test.de`,
        passwordHash: await bcrypt.hash("test1234", 10),
        role: "MANAGER",
        isActive: false,
      },
    });
    const request = await createLeaveRequest({
      employeeId: data.employee.id,
      leaveTypeId: data.vacationType.id,
      start: "2027-04-26",
      end: "2027-04-30",
      days: 5,
      status: "APPROVED",
      reviewedBy: inactiveUser.id,
    });
    await bookEntitlement(data.employee.id, data.vacationType.id, 2027, 5);

    await app.prisma.$transaction(async (tx) => {
      await createBsAbsenceTx(tx, data.employee.id, "2027-04-27");
      return correctLeaveForNewVocationalSchoolDay(tx, app.audit, {
        tenantId: data.tenant.id,
        employeeId: data.employee.id,
        date: mkDate("2027-04-27"),
        trigger: "PATTERN",
      });
    });

    const notifications = await getNotifications(request.id);
    const recipientIds = notifications.map((n) => n.userId);
    expect(recipientIds).toContain(data.adminUser.id); // fallback holder (ADMIN, wholeTenant reach)
    expect(recipientIds).not.toContain(inactiveUser.id);
  });

  it("BS date in a closed month: no LeaveRequest/entitlement change, one correction-needed notification per approver, none on a repeat call", async () => {
    const request = await createLeaveRequest({
      employeeId: data.employee.id,
      leaveTypeId: data.vacationType.id,
      start: "2027-05-03",
      end: "2027-05-07",
      days: 5,
      status: "APPROVED",
      reviewedBy: data.adminUser.id,
    });
    await bookEntitlement(data.employee.id, data.vacationType.id, 2027, 5);

    const { start: monthStart } = monthRangeUtc(2027, 5, "Europe/Berlin");
    await app.prisma.saldoSnapshot.create({
      data: {
        employeeId: data.employee.id,
        periodType: "MONTHLY",
        periodStart: monthStart,
        periodEnd: monthStart,
        workedMinutes: 0,
        expectedMinutes: 0,
        balanceMinutes: 0,
        carryOver: 0,
        closedAt: new Date(),
      },
    });

    const run = () =>
      app.prisma.$transaction(async (tx) =>
        correctLeaveForNewVocationalSchoolDay(tx, app.audit, {
          tenantId: data.tenant.id,
          employeeId: data.employee.id,
          date: mkDate("2027-05-04"),
          trigger: "PATTERN",
        }),
      );

    await app.prisma.$transaction(async (tx) =>
      createBsAbsenceTx(tx, data.employee.id, "2027-05-04"),
    );
    const first = await run();
    expect(first.corrected).toEqual([]);
    expect(first.flagged).toEqual([request.id]);

    const updated = await app.prisma.leaveRequest.findUniqueOrThrow({ where: { id: request.id } });
    expect(Number(updated.days)).toBe(5); // unchanged

    const notificationsAfterFirst = await getNotifications(request.id);
    expect(
      notificationsAfterFirst.filter((n) => n.type === LEAVE_CORRECTION_NEEDED_VOCATIONAL_SCHOOL),
    ).toHaveLength(1);

    const second = await run();
    expect(second.flagged).toEqual([request.id]); // still reported as closed-month, but...
    const notificationsAfterSecond = await getNotifications(request.id);
    expect(
      notificationsAfterSecond.filter((n) => n.type === LEAVE_CORRECTION_NEEDED_VOCATIONAL_SCHOOL),
    ).toHaveLength(1); // ...no NEW notification (dedup)
  });

  it("flagLockedVocationalSchoolLeaveOverlaps: a locked pattern date inside an APPROVED VACATION notifies once, deduplicated across calls", async () => {
    const request = await createLeaveRequest({
      employeeId: data.employee.id,
      leaveTypeId: data.vacationType.id,
      start: "2027-05-10",
      end: "2027-05-14",
      days: 5,
      status: "APPROVED",
      reviewedBy: data.adminUser.id,
    });

    const call = () =>
      app.prisma.$transaction(async (tx) =>
        flagLockedVocationalSchoolLeaveOverlaps(tx, {
          tenantId: data.tenant.id,
          employeeId: data.employee.id,
          dates: [mkDate("2027-05-11")],
        }),
      );

    const first = await call();
    expect(first).toEqual([request.id]);
    const notifications = await getNotifications(request.id);
    expect(
      notifications.filter((n) => n.type === LEAVE_CORRECTION_NEEDED_VOCATIONAL_SCHOOL),
    ).toHaveLength(1);

    const second = await call();
    expect(second).toEqual([request.id]); // still reported, no new row
    const notificationsAfter = await getNotifications(request.id);
    expect(
      notificationsAfter.filter((n) => n.type === LEAVE_CORRECTION_NEEDED_VOCATIONAL_SCHOOL),
    ).toHaveLength(1);
  });

  it("flagLockedVocationalSchoolLeaveOverlaps: a date outside any vacation flags nothing", async () => {
    const result = await app.prisma.$transaction(async (tx) =>
      flagLockedVocationalSchoolLeaveOverlaps(tx, {
        tenantId: data.tenant.id,
        employeeId: data.employee.id,
        dates: [mkDate("2027-05-31")],
      }),
    );
    expect(result).toEqual([]);
  });

  it("an error inside the correction rolls back the surrounding transaction, including a BS row created in it (T-448-06)", async () => {
    const request = await createLeaveRequest({
      employeeId: data.employee.id,
      leaveTypeId: data.vacationType.id,
      start: "2027-06-07",
      end: "2027-06-11",
      days: 5,
      status: "APPROVED",
      reviewedBy: data.adminUser.id,
    });
    await bookEntitlement(data.employee.id, data.vacationType.id, 2027, 5);

    await expect(
      app.prisma.$transaction(async (tx) => {
        await createBsAbsenceTx(tx, data.employee.id, "2027-06-08");
        await correctLeaveForNewVocationalSchoolDay(tx, app.audit, {
          tenantId: data.tenant.id,
          employeeId: data.employee.id,
          date: mkDate("2027-06-08"),
          trigger: "PATTERN",
        });
        throw new Error("forced rollback (T-448-06)");
      }),
    ).rejects.toThrow("forced rollback (T-448-06)");

    const absence = await app.prisma.absence.findFirst({
      where: {
        employeeId: data.employee.id,
        type: "VOCATIONAL_SCHOOL",
        startDate: mkDate("2027-06-08"),
      },
    });
    expect(absence).toBeNull(); // the BS row rolled back too

    const updated = await app.prisma.leaveRequest.findUniqueOrThrow({ where: { id: request.id } });
    expect(Number(updated.days)).toBe(5); // unchanged

    const entitlement = await app.prisma.leaveEntitlement.findUniqueOrThrow({
      where: {
        employeeId_leaveTypeId_year: {
          employeeId: data.employee.id,
          leaveTypeId: data.vacationType.id,
          year: 2027,
        },
      },
    });
    expect(Number(entitlement.usedDays)).toBe(5); // unchanged

    expect(await getCorrectionAudit(request.id)).toBeNull();
    expect(await getNotifications(request.id)).toHaveLength(0);
  });
});

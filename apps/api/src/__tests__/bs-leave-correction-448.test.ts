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

  // ── Task 2: wired through the real HTTP write paths ─────────────────────────────────────

  async function createAzubiEmployee(label: string) {
    const s = `${label}-${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
    const user = await app.prisma.user.create({
      data: {
        email: `${s}@test.de`,
        passwordHash: await bcrypt.hash("test1234", 10),
        role: "EMPLOYEE",
        isActive: true,
      },
    });
    const employee = await app.prisma.employee.create({
      data: {
        tenantId: data.tenant.id,
        userId: user.id,
        employeeNumber: s.toUpperCase().slice(0, 20),
        firstName: label,
        lastName: "BsCorrTask2",
        hireDate: new Date("2020-01-01"),
        classification: "AZUBI",
        birthDate: new Date("2005-01-01"),
      },
    });
    return { user, employee };
  }

  it("POST /manual-insert for a Tuesday over an APPROVED Mo-Fr VACATION: 201, days 4, entitlement -1, LEAVE_CORRECTED audit (actor = manager), Azubi + approver notified", async () => {
    const request = await createLeaveRequest({
      employeeId: data.employee.id,
      leaveTypeId: data.vacationType.id,
      start: "2026-10-26",
      end: "2026-10-30",
      days: 5,
      status: "APPROVED",
      reviewedBy: data.adminUser.id,
    });
    await bookEntitlement(data.employee.id, data.vacationType.id, 2026, 5);

    const res = await app.inject({
      method: "POST",
      url: "/api/v1/vocational-school/manual-insert",
      headers: { authorization: `Bearer ${data.adminToken}` },
      payload: { employeeId: data.employee.id, date: "2026-10-27" },
    });
    expect(res.statusCode).toBe(201);

    const updated = await app.prisma.leaveRequest.findUniqueOrThrow({ where: { id: request.id } });
    expect(Number(updated.days)).toBe(4);
    const entitlement = await app.prisma.leaveEntitlement.findUniqueOrThrow({
      where: {
        employeeId_leaveTypeId_year: {
          employeeId: data.employee.id,
          leaveTypeId: data.vacationType.id,
          year: 2026,
        },
      },
    });
    expect(Number(entitlement.usedDays)).toBe(4);

    const audit = await getCorrectionAudit(request.id);
    expect(audit?.userId).toBe(data.adminUser.id);
    expect((audit!.newValue as Record<string, unknown>).trigger).toBe("MANUAL");

    expect(await getNotifications(request.id)).toHaveLength(2);
  });

  it("POST /generate with a Tuesday pattern over an APPROVED VACATION: request re-priced, audit origin SYSTEM, trigger PATTERN", async () => {
    await app.prisma.employeeVocationalSchoolPattern.create({
      data: {
        employeeId: data.employee.id,
        dayOfWeek: 1, // Tuesday (0=Mon..6=Sun encoding this codebase uses)
        daysOfWeek: [1],
        blockWeeks: [],
        validFrom: new Date("2020-01-01"),
        isActive: true,
      },
    });
    const request = await createLeaveRequest({
      employeeId: data.employee.id,
      leaveTypeId: data.vacationType.id,
      start: "2026-11-09",
      end: "2026-11-13",
      days: 5,
      status: "APPROVED",
      reviewedBy: data.adminUser.id,
    });
    await bookEntitlement(data.employee.id, data.vacationType.id, 2026, 5);

    const genRes = await app.inject({
      method: "POST",
      url: "/api/v1/vocational-school/generate",
      headers: { authorization: `Bearer ${data.adminToken}` },
    });
    expect(genRes.statusCode).toBe(200);

    const absence = await app.prisma.absence.findFirst({
      where: {
        employeeId: data.employee.id,
        type: "VOCATIONAL_SCHOOL",
        startDate: mkDate("2026-11-10"),
        deletedAt: null,
      },
    });
    expect(absence).toBeTruthy();

    const updated = await app.prisma.leaveRequest.findUniqueOrThrow({ where: { id: request.id } });
    expect(Number(updated.days)).toBe(4);

    const audit = await getCorrectionAudit(request.id);
    expect((audit!.newValue as Record<string, unknown>).origin).toBe("SYSTEM");
    expect((audit!.newValue as Record<string, unknown>).trigger).toBe("PATTERN");
  });

  it("Generator P2002 restore branch (soft-deleted PATTERN row restored) over an APPROVED VACATION: correction runs too", async () => {
    // The previous test's tenant-wide /generate call already created every future Tuesday for
    // the pattern above, including 2026-11-17. Soft-delete it (simulating a prior orphan-sweep)
    // so the next /generate call hits the P2002-restore branch for exactly this date.
    await app.prisma.absence.updateMany({
      where: {
        employeeId: data.employee.id,
        type: "VOCATIONAL_SCHOOL",
        startDate: mkDate("2026-11-17"),
      },
      data: { deletedAt: new Date() },
    });
    const request = await createLeaveRequest({
      employeeId: data.employee.id,
      leaveTypeId: data.vacationType.id,
      start: "2026-11-16",
      end: "2026-11-20",
      days: 5,
      status: "APPROVED",
      reviewedBy: data.adminUser.id,
    });
    await bookEntitlement(data.employee.id, data.vacationType.id, 2026, 5);

    const genRes = await app.inject({
      method: "POST",
      url: "/api/v1/vocational-school/generate",
      headers: { authorization: `Bearer ${data.adminToken}` },
    });
    expect(genRes.statusCode).toBe(200);

    const restored = await app.prisma.absence.findFirst({
      where: {
        employeeId: data.employee.id,
        type: "VOCATIONAL_SCHOOL",
        startDate: mkDate("2026-11-17"),
      },
    });
    expect(restored?.deletedAt).toBeNull();

    const updated = await app.prisma.leaveRequest.findUniqueOrThrow({ where: { id: request.id } });
    expect(Number(updated.days)).toBe(4);
  });

  it("GET /preview (dry run) over a fresh pattern + APPROVED VACATION: no request change, no audit, no notification", async () => {
    const { employee: previewEmployee } = await createAzubiEmployee("preview448");
    await app.prisma.workSchedule.create({
      data: {
        employeeId: previewEmployee.id,
        weeklyHours: 40,
        mondayHours: 8,
        tuesdayHours: 8,
        wednesdayHours: 8,
        thursdayHours: 8,
        fridayHours: 8,
        saturdayHours: 0,
        sundayHours: 0,
        validFrom: new Date("2020-01-01"),
      },
    });
    await app.prisma.overtimeAccount.create({
      data: { employeeId: previewEmployee.id, balanceHours: 0 },
    });
    await app.prisma.employeeVocationalSchoolPattern.create({
      data: {
        employeeId: previewEmployee.id,
        dayOfWeek: 1,
        daysOfWeek: [1],
        blockWeeks: [],
        validFrom: new Date("2020-01-01"),
        isActive: true,
      },
    });
    const request = await createLeaveRequest({
      employeeId: previewEmployee.id,
      leaveTypeId: data.vacationType.id,
      start: "2026-11-23",
      end: "2026-11-27",
      days: 5,
      status: "APPROVED",
      reviewedBy: data.adminUser.id,
    });
    await seedEntitlementYears(app, {
      employeeId: previewEmployee.id,
      leaveTypeId: data.vacationType.id,
      years: [2026],
      totalDays: 30,
    });
    await bookEntitlement(previewEmployee.id, data.vacationType.id, 2026, 5);

    const res = await app.inject({
      method: "GET",
      url: "/api/v1/vocational-school/preview",
      headers: { authorization: `Bearer ${data.adminToken}` },
    });
    expect(res.statusCode).toBe(200);

    const absence = await app.prisma.absence.findFirst({
      where: { employeeId: previewEmployee.id, type: "VOCATIONAL_SCHOOL" },
    });
    expect(absence).toBeNull();

    const updated = await app.prisma.leaveRequest.findUniqueOrThrow({ where: { id: request.id } });
    expect(Number(updated.days)).toBe(5);
    expect(await getCorrectionAudit(request.id)).toBeNull();
    expect(await getNotifications(request.id)).toHaveLength(0);
  });

  it("POST /retroactive-apply over a CLOSED month whose pattern Tuesday lies in an APPROVED VACATION: no BS row, no request change, one correction-needed notification per approver; a second call sends none", async () => {
    const { employee: retroEmployee } = await createAzubiEmployee("retro448");
    await app.prisma.employeeVocationalSchoolPattern.create({
      data: {
        employeeId: retroEmployee.id,
        dayOfWeek: 1,
        daysOfWeek: [1],
        blockWeeks: [],
        validFrom: new Date("2026-08-01"),
        isActive: true,
      },
    });
    const request = await createLeaveRequest({
      employeeId: retroEmployee.id,
      leaveTypeId: data.vacationType.id,
      start: "2026-08-03",
      end: "2026-08-07",
      days: 5,
      status: "APPROVED",
      reviewedBy: data.adminUser.id,
    });
    await seedEntitlementYears(app, {
      employeeId: retroEmployee.id,
      leaveTypeId: data.vacationType.id,
      years: [2026],
      totalDays: 30,
    });
    await bookEntitlement(retroEmployee.id, data.vacationType.id, 2026, 5);

    const { start: augStart } = monthRangeUtc(2026, 8, "Europe/Berlin");
    await app.prisma.saldoSnapshot.create({
      data: {
        employeeId: retroEmployee.id,
        periodType: "MONTHLY",
        periodStart: augStart,
        periodEnd: augStart,
        workedMinutes: 0,
        expectedMinutes: 0,
        balanceMinutes: 0,
        carryOver: 0,
        closedAt: new Date(),
      },
    });

    const runRetro = () =>
      app.inject({
        method: "POST",
        url: "/api/v1/vocational-school/retroactive-apply",
        headers: { authorization: `Bearer ${data.adminToken}` },
        payload: { employeeId: retroEmployee.id },
      });

    const first = await runRetro();
    expect(first.statusCode).toBe(200);

    const bsRow = await app.prisma.absence.findFirst({
      where: {
        employeeId: retroEmployee.id,
        type: "VOCATIONAL_SCHOOL",
        startDate: mkDate("2026-08-04"),
      },
    });
    expect(bsRow).toBeNull(); // the locked month never gets a BS row

    const updated = await app.prisma.leaveRequest.findUniqueOrThrow({ where: { id: request.id } });
    expect(Number(updated.days)).toBe(5); // unchanged

    const notificationsAfterFirst = (await getNotifications(request.id)).filter(
      (n) => n.type === LEAVE_CORRECTION_NEEDED_VOCATIONAL_SCHOOL,
    );
    expect(notificationsAfterFirst).toHaveLength(1);

    const second = await runRetro();
    expect(second.statusCode).toBe(200);
    const notificationsAfterSecond = (await getNotifications(request.id)).filter(
      (n) => n.type === LEAVE_CORRECTION_NEEDED_VOCATIONAL_SCHOOL,
    );
    expect(notificationsAfterSecond).toHaveLength(1); // no new row (dedup)
  });

  it("POST /manual-insert with no overlapping vacation request: 201, plain insert, no correction side-effects", async () => {
    const { employee: soloEmployee } = await createAzubiEmployee("solo448");
    const res = await app.inject({
      method: "POST",
      url: "/api/v1/vocational-school/manual-insert",
      headers: { authorization: `Bearer ${data.adminToken}` },
      payload: { employeeId: soloEmployee.id, date: "2026-10-28" },
    });
    expect(res.statusCode).toBe(201);
    const body = JSON.parse(res.body);
    expect(body.source).toBe("MANUAL");
  });
});

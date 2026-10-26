/**
 * Issue #718 (DSGVO Art. 17): the anonymization also clears the person-authored free texts
 * LeaveRequest.reviewNote, RetroEntryRequest.reason (neutral text, required column) and
 * reviewNote, OvertimePlan.note, Shift.note and EmployeeAvailability.note - rows stay - and keeps
 * the texts the business writes to document a booking (SaldoSnapshot.note, OpeningBalance texts).
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import bcrypt from "bcryptjs";
import crypto from "crypto";
import type { FastifyInstance } from "fastify";
import { getTestApp, seedTestData, cleanupTestData } from "./setup";
import { anonymizeEmployeeData } from "../contexts/platform/anonymize";
import { RETRO_REASON_ANONYMIZED } from "../contexts/time-tracking";

const T = "Freitext 718 mit Namen Frau Beispiel";

describe("anonymization clears the remaining person-authored free texts (#718)", () => {
  let app: FastifyInstance;
  let data: Awaited<ReturnType<typeof seedTestData>>;
  let target: string;
  let other: string;

  async function makeEmployee(label: string) {
    const suffix = crypto.randomUUID().slice(0, 8);
    const user = await app.prisma.user.create({
      data: {
        email: `${label}-${suffix}@test.local`,
        passwordHash: await bcrypt.hash("test1234", 10),
        role: "EMPLOYEE",
        isActive: true,
      },
    });
    return app.prisma.employee.create({
      data: {
        tenantId: data.tenant.id,
        userId: user.id,
        firstName: "Max",
        lastName: label,
        employeeNumber: `${label}-${suffix}`,
        hireDate: new Date("2024-01-01"),
      },
    });
  }

  async function seedTexts(employeeId: string) {
    const day = new Date("2025-06-16");
    await app.prisma.leaveRequest.create({
      data: {
        employeeId,
        leaveTypeId: data.vacationType.id,
        startDate: day,
        endDate: day,
        days: 1,
        status: "APPROVED",
        reviewNote: T,
      },
    });
    // A soft-deleted request keeps its text and must be reached too.
    await app.prisma.leaveRequest.create({
      data: {
        employeeId,
        leaveTypeId: data.vacationType.id,
        startDate: new Date("2025-06-17"),
        endDate: new Date("2025-06-17"),
        days: 1,
        status: "REJECTED",
        reviewNote: T,
        deletedAt: new Date("2025-06-18T00:00:00Z"),
      },
    });
    await app.prisma.retroEntryRequest.create({
      data: {
        employeeId,
        targetDate: day,
        reason: T,
        status: "APPROVED",
        reviewNote: T,
        reviewedBy: data.adminUser.id,
        reviewedAt: new Date("2025-06-18T00:00:00Z"),
      },
    });
    await app.prisma.overtimePlan.create({
      data: {
        employeeId,
        hoursToReduce: 4,
        deadline: new Date("2026-12-31T00:00:00Z"),
        note: T,
        createdBy: data.adminUser.id,
      },
    });
    await app.prisma.shift.create({
      data: {
        employeeId,
        salonId: data.salonId!,
        date: day,
        startTime: "08:00",
        endTime: "16:00",
        note: T,
      },
    });
    await app.prisma.employeeAvailability.create({
      data: {
        employeeId,
        dayOfWeek: 2,
        status: "UNAVAILABLE",
        note: T,
        validFrom: new Date("2025-01-01"),
      },
    });
    // Business-written texts that must survive.
    await app.prisma.saldoSnapshot.create({
      data: {
        employeeId,
        periodType: "MONTHLY",
        periodStart: new Date("2025-05-01"),
        periodEnd: new Date("2025-05-31"),
        workedMinutes: 0,
        expectedMinutes: 0,
        balanceMinutes: 0,
        carryOver: 0,
        closedAt: new Date("2025-06-01T00:00:00Z"),
        note: "BOOKING-NOTE",
      },
    });
    await app.prisma.openingBalance.create({
      data: {
        employeeId,
        minutes: 60,
        effectiveFrom: new Date("2025-01-01"),
        reason: "BOOKING-REASON",
        evidenceRef: "BOOKING-REF",
        source: "ADMIN_ENTRY",
        createdBy: data.adminUser.id,
      },
    });
  }

  const counts = (employeeId: string) =>
    Promise.all([
      app.prisma.leaveRequest.count({ where: { employeeId } }),
      app.prisma.retroEntryRequest.count({ where: { employeeId } }),
      app.prisma.overtimePlan.count({ where: { employeeId } }),
      app.prisma.shift.count({ where: { employeeId } }),
      app.prisma.employeeAvailability.count({ where: { employeeId } }),
      app.prisma.saldoSnapshot.count({ where: { employeeId } }),
      app.prisma.openingBalance.count({ where: { employeeId } }),
    ]);

  beforeAll(async () => {
    app = await getTestApp();
    data = await seedTestData(app, "anon-718");
    target = (await makeEmployee("target718")).id;
    other = (await makeEmployee("other718")).id;
    await seedTexts(target);
    await seedTexts(other);
  });

  afterAll(async () => {
    try {
      await cleanupTestData(app, data.tenant.id);
    } catch (err) {
      console.error("anonymization-freetext-718 cleanup failed:", err);
    }
  });

  it("negative control: before the anonymization every text is present", async () => {
    expect(
      await app.prisma.leaveRequest.count({ where: { employeeId: target, reviewNote: T } }),
    ).toBe(2);
    expect(
      await app.prisma.retroEntryRequest.count({
        where: { employeeId: target, reason: T, reviewNote: T },
      }),
    ).toBe(1);
    expect(await app.prisma.overtimePlan.count({ where: { employeeId: target, note: T } })).toBe(1);
    expect(await app.prisma.shift.count({ where: { employeeId: target, note: T } })).toBe(1);
    expect(
      await app.prisma.employeeAvailability.count({ where: { employeeId: target, note: T } }),
    ).toBe(1);
  });

  it("clears every listed field, keeps the rows and the business texts, leaves others alone", async () => {
    const rowsBefore = await counts(target);
    await app.prisma.$transaction((tx) =>
      anonymizeEmployeeData({
        tx,
        employeeId: target,
        exitDayIfUnset: new Date("2026-03-10T00:00:00Z"),
      }),
    );

    expect(await counts(target)).toEqual(rowsBefore); // no row deleted
    expect(
      await app.prisma.leaveRequest.count({
        where: { employeeId: target, reviewNote: { not: null } },
      }),
    ).toBe(0);
    const retro = await app.prisma.retroEntryRequest.findFirstOrThrow({
      where: { employeeId: target },
    });
    expect(retro.reason).toBe(RETRO_REASON_ANONYMIZED);
    expect(retro.reviewNote).toBeNull();
    // The approval record itself is untouched.
    expect(retro.status).toBe("APPROVED");
    expect(retro.reviewedBy).toBe(data.adminUser.id);
    expect(
      await app.prisma.overtimePlan.count({ where: { employeeId: target, note: { not: null } } }),
    ).toBe(0);
    expect(
      await app.prisma.shift.count({ where: { employeeId: target, note: { not: null } } }),
    ).toBe(0);
    expect(
      await app.prisma.employeeAvailability.count({
        where: { employeeId: target, note: { not: null } },
      }),
    ).toBe(0);

    // Deliberately kept: texts written by the business to document a booking (§ 147 AO).
    const snap = await app.prisma.saldoSnapshot.findFirstOrThrow({ where: { employeeId: target } });
    expect(snap.note).toBe("BOOKING-NOTE");
    const ob = await app.prisma.openingBalance.findFirstOrThrow({ where: { employeeId: target } });
    expect([ob.reason, ob.evidenceRef]).toEqual(["BOOKING-REASON", "BOOKING-REF"]);

    // Another employee of the same tenant is untouched.
    expect(
      await app.prisma.leaveRequest.count({ where: { employeeId: other, reviewNote: T } }),
    ).toBe(2);
    const otherRetro = await app.prisma.retroEntryRequest.findFirstOrThrow({
      where: { employeeId: other },
    });
    expect([otherRetro.reason, otherRetro.reviewNote]).toEqual([T, T]);
    expect(await app.prisma.overtimePlan.count({ where: { employeeId: other, note: T } })).toBe(1);
    expect(await app.prisma.shift.count({ where: { employeeId: other, note: T } })).toBe(1);
    expect(
      await app.prisma.employeeAvailability.count({ where: { employeeId: other, note: T } }),
    ).toBe(1);
  });

  it("is idempotent: a second run changes nothing and does not fail", async () => {
    await app.prisma.$transaction((tx) =>
      anonymizeEmployeeData({
        tx,
        employeeId: target,
        exitDayIfUnset: new Date("2026-03-10T00:00:00Z"),
      }),
    );
    const retro = await app.prisma.retroEntryRequest.findFirstOrThrow({
      where: { employeeId: target },
    });
    expect(retro.reason).toBe(RETRO_REASON_ANONYMIZED);
  });
});

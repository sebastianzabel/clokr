/**
 * Issue #774: the backfill clears, for persons anonymized BEFORE #718, the free texts #718 now
 * clears - with the same helpers - and nothing else.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import bcrypt from "bcryptjs";
import crypto from "crypto";
import type { FastifyInstance } from "fastify";
import { getTestApp, seedTestData, cleanupTestData, soleAuditRow } from "../../src/__tests__/setup";
import { RETRO_REASON_ANONYMIZED } from "../../src/contexts/time-tracking";
import { runBackfill, BACKFILL_MARKER } from "../backfill-774-anonymized-freetext";

const T = "Freitext 774 mit Namen Frau Beispiel";

describe("backfill 774: anonymized free texts (Bestand)", () => {
  let app: FastifyInstance;
  let data: Awaited<ReturnType<typeof seedTestData>>;
  let legacy: string;
  let live: string;

  async function makeEmployee(label: string, anonymized = false) {
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
        firstName: anonymized ? "Gelöscht" : "Max",
        lastName: anonymized ? `GELÖSCHT-${label}` : label,
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

  const remaining = async (employeeId: string) => ({
    leave: await app.prisma.leaveRequest.count({
      where: { employeeId, reviewNote: { not: null } },
    }),
    retroReason: await app.prisma.retroEntryRequest.count({
      where: { employeeId, reason: { not: RETRO_REASON_ANONYMIZED } },
    }),
    retroNote: await app.prisma.retroEntryRequest.count({
      where: { employeeId, reviewNote: { not: null } },
    }),
    plan: await app.prisma.overtimePlan.count({ where: { employeeId, note: { not: null } } }),
    shift: await app.prisma.shift.count({ where: { employeeId, note: { not: null } } }),
    avail: await app.prisma.employeeAvailability.count({
      where: { employeeId, note: { not: null } },
    }),
  });
  const audits = (employeeId: string) =>
    app.prisma.auditLog.count({
      where: { entity: "Employee", entityId: employeeId, action: "UPDATE" },
    });

  beforeAll(async () => {
    app = await getTestApp();
    data = await seedTestData(app, "backfill-774");
    legacy = (await makeEmployee("legacy774", true)).id;
    live = (await makeEmployee("live774")).id;
    await seedTexts(legacy);
    await seedTexts(live);
  });

  afterAll(async () => {
    try {
      await cleanupTestData(app, data.tenant.id);
    } catch (err) {
      console.error("backfill-774 cleanup failed:", err);
    }
  });

  it("dry run reports the counts and writes nothing", async () => {
    const results = await runBackfill(app, { confirm: false, tenantId: data.tenant.id });
    expect(results.map((r) => r.employeeId)).toEqual([legacy]);
    expect(results[0].outcome).toBe("planned");
    expect(results[0].cleared).toEqual({
      leaveReviewNotes: 2,
      retroReasons: 1,
      retroReviewNotes: 1,
      overtimePlanNotes: 1,
      shiftNotes: 1,
      availabilityNotes: 1,
    });
    expect(await remaining(legacy)).toEqual({
      leave: 2,
      retroReason: 1,
      retroNote: 1,
      plan: 1,
      shift: 1,
      avail: 1,
    });
    expect(await audits(legacy)).toBe(0);
  });

  it("confirm clears exactly the anonymized person, keeps rows and business texts, audits counts", async () => {
    const results = await runBackfill(app, { confirm: true, tenantId: data.tenant.id });
    expect(results.map((r) => [r.employeeId, r.outcome])).toEqual([[legacy, "written"]]);
    expect(await remaining(legacy)).toEqual({
      leave: 0,
      retroReason: 0,
      retroNote: 0,
      plan: 0,
      shift: 0,
      avail: 0,
    });
    // Rows stay.
    expect(await app.prisma.leaveRequest.count({ where: { employeeId: legacy } })).toBe(2);
    expect(await app.prisma.retroEntryRequest.count({ where: { employeeId: legacy } })).toBe(1);
    // Kept texts.
    const snap = await app.prisma.saldoSnapshot.findFirstOrThrow({ where: { employeeId: legacy } });
    expect(snap.note).toBe("BOOKING-NOTE");
    const ob = await app.prisma.openingBalance.findFirstOrThrow({ where: { employeeId: legacy } });
    expect([ob.reason, ob.evidenceRef]).toEqual(["BOOKING-REASON", "BOOKING-REF"]);
    // A non-anonymized person is untouched.
    expect(await remaining(live)).toEqual({
      leave: 2,
      retroReason: 1,
      retroNote: 1,
      plan: 1,
      shift: 1,
      avail: 1,
    });
    // One audit row, marker and counts, no text.
    const row = await soleAuditRow(app.prisma, {
      where: { entity: "Employee", entityId: legacy, action: "UPDATE" },
    });
    expect(row.newValue).toEqual({
      clearedFreeText: results[0].cleared,
      ...BACKFILL_MARKER,
    });
    expect(JSON.stringify(row.newValue)).not.toContain(T);
  });

  it("is idempotent: a second run finds nothing and writes no audit row", async () => {
    const results = await runBackfill(app, { confirm: true, tenantId: data.tenant.id });
    expect(results.map((r) => r.outcome)).toEqual(["unchanged"]);
    expect(await audits(legacy)).toBe(1);
  });
});

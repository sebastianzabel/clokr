// Phase 77 Plan 02 — adapter contract tests. Single read path for all v1.9+ saldo sites (PITFALLS.md S-1).
//
// 12 tests covering the loadWorkEventsForRange adapter contract:
//  1. empty range returns zeros
//  2. workedMinutes aggregation
//  3. expectedMinutes treats NULL as 0
//  4. Phase 63 D-01..D-04 invariant: FIXED_SCHEDULE / SHIFT_BASED rows net-neutral
//  5. Phase 63 D-04 invariant: MONTHLY_HOURS rows contribute to worked only
//  6. coveredDates is ISO-date Set
//  7. soft-delete filter (deletedAt: null)
//  8. half-open range [from, to)
//  9. multi-employee isolation (one employeeId only)
// 10. data outside range stays excluded
// 11. type-agnostic — no inline VOCATIONAL_SCHOOL filter (future-proof)
// 12. tenant isolation is endpoint-layer responsibility — adapter does NOT filter tenant (PITFALLS.md M-3)
//
// Pattern mirrors recalculate-snapshots.test.ts: real Prisma against test DB,
// per-suite seed in beforeAll, per-test wipe of WorkEvent rows in beforeEach.
import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import { getTestApp, closeTestApp, cleanupTestData } from "../../__tests__/setup";
import { loadWorkEventsForRange } from "../work-event";
import type { FastifyInstance } from "fastify";
import bcrypt from "bcryptjs";

describe("loadWorkEventsForRange (Phase 77 Plan 02)", () => {
  let app: FastifyInstance;
  let tenantAId: string;
  let tenantBId: string;
  let employeeAId: string;
  let employeeA2Id: string;
  let employeeBId: string;

  // Canonical UTC range: 2026-06-01T00:00:00Z .. 2026-07-01T00:00:00Z (half-open).
  const RANGE_START = new Date("2026-06-01T00:00:00Z");
  const RANGE_END = new Date("2026-07-01T00:00:00Z");

  beforeAll(async () => {
    app = await getTestApp();
    const prisma = app.prisma;
    const s = "we77-02-" + Date.now().toString(36);

    // Tenant A
    const tenantA = await prisma.tenant.create({
      data: { name: `WE 77-02 A ${s}`, slug: `we-a-${s}`, federalState: "NIEDERSACHSEN" },
    });
    tenantAId = tenantA.id;
    await prisma.tenantConfig.create({
      data: {
        tenantId: tenantAId,
        defaultVacationDays: 30,
        timezone: "Europe/Berlin",
        workEventModelLive: true, // Phase 78: route to WorkEvent-branch for these tests
      },
    });

    // Tenant B (for the M-3 tenant-isolation boundary test)
    const tenantB = await prisma.tenant.create({
      data: { name: `WE 77-02 B ${s}`, slug: `we-b-${s}`, federalState: "NIEDERSACHSEN" },
    });
    tenantBId = tenantB.id;
    await prisma.tenantConfig.create({
      data: {
        tenantId: tenantBId,
        defaultVacationDays: 30,
        timezone: "Europe/Berlin",
        workEventModelLive: true, // Phase 78: route to WorkEvent-branch for these tests
      },
    });

    // Employee A (tenant A)
    const userA = await prisma.user.create({
      data: {
        email: `a-${s}@test.de`,
        passwordHash: await bcrypt.hash("test1234", 10),
        role: "EMPLOYEE",
        isActive: true,
      },
    });
    const empA = await prisma.employee.create({
      data: {
        tenantId: tenantAId,
        userId: userA.id,
        employeeNumber: `EA-${s}`,
        firstName: "A.",
        lastName: "E.",
        hireDate: new Date("2026-01-01"),
      },
    });
    employeeAId = empA.id;

    // Employee A2 (tenant A, second employee — for multi-employee isolation)
    const userA2 = await prisma.user.create({
      data: {
        email: `a2-${s}@test.de`,
        passwordHash: await bcrypt.hash("test1234", 10),
        role: "EMPLOYEE",
        isActive: true,
      },
    });
    const empA2 = await prisma.employee.create({
      data: {
        tenantId: tenantAId,
        userId: userA2.id,
        employeeNumber: `EA2-${s}`,
        firstName: "A2.",
        lastName: "E.",
        hireDate: new Date("2026-01-01"),
      },
    });
    employeeA2Id = empA2.id;

    // Employee B (tenant B — for tenant-isolation boundary test 12)
    const userB = await prisma.user.create({
      data: {
        email: `b-${s}@test.de`,
        passwordHash: await bcrypt.hash("test1234", 10),
        role: "EMPLOYEE",
        isActive: true,
      },
    });
    const empB = await prisma.employee.create({
      data: {
        tenantId: tenantBId,
        userId: userB.id,
        employeeNumber: `EB-${s}`,
        firstName: "B.",
        lastName: "E.",
        hireDate: new Date("2026-01-01"),
      },
    });
    employeeBId = empB.id;
  });

  afterAll(async () => {
    try {
      const allEmpIds = [employeeAId, employeeA2Id, employeeBId];
      await app.prisma.workEvent.deleteMany({ where: { employeeId: { in: allEmpIds } } });
      await cleanupTestData(app, tenantAId);
      await cleanupTestData(app, tenantBId);
    } catch (err) {
      console.error("work-event 77-02 test cleanup failed:", err);
    }
    await closeTestApp();
  });

  beforeEach(async () => {
    // Wipe WorkEvent rows for all test employees so each test sees a clean slate.
    const allEmpIds = [employeeAId, employeeA2Id, employeeBId];
    await app.prisma.workEvent.deleteMany({ where: { employeeId: { in: allEmpIds } } });
  });

  // ── Test 1 ─────────────────────────────────────────────────────────────────
  it("1. returns zeros for empty range (no WorkEvent rows exist)", async () => {
    const result = await loadWorkEventsForRange(app.prisma, employeeAId, RANGE_START, RANGE_END);
    expect(result.workedMinutes).toBe(0);
    expect(result.expectedMinutes).toBe(0);
    expect(result.coveredDates).toBeInstanceOf(Set);
    expect(result.coveredDates.size).toBe(0);
  });

  // ── Test 2 ─────────────────────────────────────────────────────────────────
  it("2. aggregates workedMinutes across multiple rows in range (3 × 480 → 1440)", async () => {
    await app.prisma.workEvent.createMany({
      data: [
        {
          employeeId: employeeAId,
          type: AbsenceType.VOCATIONAL_SCHOOL,
          source: "MANUAL",
          date: new Date("2026-06-01"),
          workedMinutes: 480,
          expectedMinutes: 480,
        },
        {
          employeeId: employeeAId,
          type: AbsenceType.VOCATIONAL_SCHOOL,
          source: "MANUAL",
          date: new Date("2026-06-08"),
          workedMinutes: 480,
          expectedMinutes: 480,
        },
        {
          employeeId: employeeAId,
          type: AbsenceType.VOCATIONAL_SCHOOL,
          source: "MANUAL",
          date: new Date("2026-06-15"),
          workedMinutes: 480,
          expectedMinutes: 480,
        },
      ],
    });
    const result = await loadWorkEventsForRange(app.prisma, employeeAId, RANGE_START, RANGE_END);
    expect(result.workedMinutes).toBe(1440);
  });

  // ── Test 3 ─────────────────────────────────────────────────────────────────
  it("3. aggregates expectedMinutes treating NULL as 0 (mix of FIXED + MONTHLY_HOURS rows)", async () => {
    await app.prisma.workEvent.createMany({
      data: [
        {
          employeeId: employeeAId,
          type: AbsenceType.VOCATIONAL_SCHOOL,
          source: "MANUAL",
          date: new Date("2026-06-01"),
          workedMinutes: 480,
          expectedMinutes: 480, // FIXED_SCHEDULE row
        },
        {
          employeeId: employeeAId,
          type: AbsenceType.VOCATIONAL_SCHOOL,
          source: "MANUAL",
          date: new Date("2026-06-08"),
          workedMinutes: 480,
          expectedMinutes: null, // MONTHLY_HOURS row
        },
        {
          employeeId: employeeAId,
          type: AbsenceType.VOCATIONAL_SCHOOL,
          source: "MANUAL",
          date: new Date("2026-06-15"),
          workedMinutes: 480,
          expectedMinutes: 240, // FIXED_SCHEDULE half-day row
        },
      ],
    });
    const result = await loadWorkEventsForRange(app.prisma, employeeAId, RANGE_START, RANGE_END);
    expect(result.workedMinutes).toBe(1440);
    expect(result.expectedMinutes).toBe(720); // 480 + 0 (null) + 240
  });

  // ── Test 4 ─────────────────────────────────────────────────────────────────
  it("4. Phase 63 D-01..D-04 invariant: FIXED_SCHEDULE/SHIFT_BASED net-neutral (worked === expected)", async () => {
    await app.prisma.workEvent.createMany({
      data: [
        {
          employeeId: employeeAId,
          type: AbsenceType.VOCATIONAL_SCHOOL,
          source: "MANUAL",
          date: new Date("2026-06-02"),
          workedMinutes: 480,
          expectedMinutes: 480,
        },
        {
          employeeId: employeeAId,
          type: AbsenceType.VOCATIONAL_SCHOOL,
          source: "PATTERN",
          date: new Date("2026-06-09"),
          workedMinutes: 480,
          expectedMinutes: 480,
        },
        {
          employeeId: employeeAId,
          type: AbsenceType.VOCATIONAL_SCHOOL,
          source: "AUTO",
          date: new Date("2026-06-16"),
          workedMinutes: 480,
          expectedMinutes: 480,
        },
      ],
    });
    const result = await loadWorkEventsForRange(app.prisma, employeeAId, RANGE_START, RANGE_END);
    expect(result.workedMinutes).toBe(1440);
    expect(result.expectedMinutes).toBe(1440);
    expect(result.workedMinutes).toBe(result.expectedMinutes); // netto-neutral
  });

  // ── Test 5 ─────────────────────────────────────────────────────────────────
  it("5. Phase 63 D-04 invariant: MONTHLY_HOURS rows contribute to worked only (expectedMinutes=NULL)", async () => {
    await app.prisma.workEvent.createMany({
      data: [
        {
          employeeId: employeeAId,
          type: AbsenceType.VOCATIONAL_SCHOOL,
          source: "MANUAL",
          date: new Date("2026-06-03"),
          workedMinutes: 480,
          expectedMinutes: null,
        },
        {
          employeeId: employeeAId,
          type: AbsenceType.VOCATIONAL_SCHOOL,
          source: "MANUAL",
          date: new Date("2026-06-10"),
          workedMinutes: 480,
          expectedMinutes: null,
        },
        {
          employeeId: employeeAId,
          type: AbsenceType.VOCATIONAL_SCHOOL,
          source: "MANUAL",
          date: new Date("2026-06-17"),
          workedMinutes: 480,
          expectedMinutes: null,
        },
      ],
    });
    const result = await loadWorkEventsForRange(app.prisma, employeeAId, RANGE_START, RANGE_END);
    expect(result.workedMinutes).toBe(1440);
    expect(result.expectedMinutes).toBe(0);
  });

  // ── Test 6 ─────────────────────────────────────────────────────────────────
  it("6. coveredDates contains ISO-date strings (YYYY-MM-DD) for every row in range", async () => {
    await app.prisma.workEvent.createMany({
      data: [
        {
          employeeId: employeeAId,
          type: AbsenceType.VOCATIONAL_SCHOOL,
          source: "MANUAL",
          date: new Date("2026-06-01"),
          workedMinutes: 480,
          expectedMinutes: 480,
        },
        {
          employeeId: employeeAId,
          type: AbsenceType.VOCATIONAL_SCHOOL,
          source: "MANUAL",
          date: new Date("2026-06-08"),
          workedMinutes: 480,
          expectedMinutes: 480,
        },
        {
          employeeId: employeeAId,
          type: AbsenceType.VOCATIONAL_SCHOOL,
          source: "MANUAL",
          date: new Date("2026-06-15"),
          workedMinutes: 480,
          expectedMinutes: 480,
        },
      ],
    });
    const result = await loadWorkEventsForRange(app.prisma, employeeAId, RANGE_START, RANGE_END);
    expect(result.coveredDates.has("2026-06-01")).toBe(true);
    expect(result.coveredDates.has("2026-06-08")).toBe(true);
    expect(result.coveredDates.has("2026-06-15")).toBe(true);
    expect(result.coveredDates.size).toBe(3);
  });

  // ── Test 7 ─────────────────────────────────────────────────────────────────
  it("7. respects soft-delete: deletedAt-set rows are excluded (CLAUDE.md soft-delete rule)", async () => {
    await app.prisma.workEvent.createMany({
      data: [
        {
          employeeId: employeeAId,
          type: AbsenceType.VOCATIONAL_SCHOOL,
          source: "MANUAL",
          date: new Date("2026-06-01"),
          workedMinutes: 480,
          expectedMinutes: 480,
        },
        {
          employeeId: employeeAId,
          type: AbsenceType.VOCATIONAL_SCHOOL,
          source: "MANUAL",
          date: new Date("2026-06-08"),
          workedMinutes: 480,
          expectedMinutes: 480,
        },
        {
          employeeId: employeeAId,
          type: AbsenceType.VOCATIONAL_SCHOOL,
          source: "MANUAL",
          date: new Date("2026-06-15"),
          workedMinutes: 480,
          expectedMinutes: 480,
          deletedAt: new Date("2026-06-20T10:00:00Z"),
        },
      ],
    });
    const result = await loadWorkEventsForRange(app.prisma, employeeAId, RANGE_START, RANGE_END);
    // Only the 2 alive rows aggregated.
    expect(result.workedMinutes).toBe(960);
    expect(result.expectedMinutes).toBe(960);
    expect(result.coveredDates.size).toBe(2);
    expect(result.coveredDates.has("2026-06-15")).toBe(false);
  });

  // ── Test 8 ─────────────────────────────────────────────────────────────────
  it("8. applies half-open range [from, to): rangeStart inclusive, rangeEnd exclusive", async () => {
    // Row exactly at rangeStart (2026-06-01) → included.
    // Row exactly at rangeEnd   (2026-07-01) → excluded.
    // Row one day before rangeEnd (2026-06-30) → included.
    await app.prisma.workEvent.createMany({
      data: [
        {
          employeeId: employeeAId,
          type: AbsenceType.VOCATIONAL_SCHOOL,
          source: "MANUAL",
          date: new Date("2026-06-01"),
          workedMinutes: 100,
          expectedMinutes: 100,
        },
        {
          employeeId: employeeAId,
          type: AbsenceType.VOCATIONAL_SCHOOL,
          source: "MANUAL",
          date: new Date("2026-06-30"),
          workedMinutes: 200,
          expectedMinutes: 200,
        },
        {
          employeeId: employeeAId,
          type: AbsenceType.VOCATIONAL_SCHOOL,
          source: "MANUAL",
          date: new Date("2026-07-01"), // == RANGE_END → excluded
          workedMinutes: 400,
          expectedMinutes: 400,
        },
      ],
    });
    const result = await loadWorkEventsForRange(app.prisma, employeeAId, RANGE_START, RANGE_END);
    expect(result.workedMinutes).toBe(300); // 100 + 200, NOT 400
    expect(result.coveredDates.has("2026-06-01")).toBe(true);
    expect(result.coveredDates.has("2026-06-30")).toBe(true);
    expect(result.coveredDates.has("2026-07-01")).toBe(false);
  });

  // ── Test 9 ─────────────────────────────────────────────────────────────────
  it("9. multi-employee isolation: only queried employeeId's rows are aggregated", async () => {
    await app.prisma.workEvent.createMany({
      data: [
        {
          employeeId: employeeAId,
          type: AbsenceType.VOCATIONAL_SCHOOL,
          source: "MANUAL",
          date: new Date("2026-06-01"),
          workedMinutes: 480,
          expectedMinutes: 480,
        },
        {
          employeeId: employeeA2Id, // different employee, same tenant
          type: AbsenceType.VOCATIONAL_SCHOOL,
          source: "MANUAL",
          date: new Date("2026-06-01"),
          workedMinutes: 999, // would obviously skew the aggregate
          expectedMinutes: 999,
        },
        {
          employeeId: employeeA2Id,
          type: AbsenceType.VOCATIONAL_SCHOOL,
          source: "MANUAL",
          date: new Date("2026-06-08"),
          workedMinutes: 999,
          expectedMinutes: 999,
        },
      ],
    });
    const result = await loadWorkEventsForRange(app.prisma, employeeAId, RANGE_START, RANGE_END);
    expect(result.workedMinutes).toBe(480); // ONLY employeeA, not A2
    expect(result.coveredDates.size).toBe(1);
    expect(result.coveredDates.has("2026-06-01")).toBe(true);
  });

  // ── Test 10 ────────────────────────────────────────────────────────────────
  it("10. data outside range returns zeros for the queried window", async () => {
    // Rows exist in May + July; range queries June → result is empty.
    await app.prisma.workEvent.createMany({
      data: [
        {
          employeeId: employeeAId,
          type: AbsenceType.VOCATIONAL_SCHOOL,
          source: "MANUAL",
          date: new Date("2026-05-25"),
          workedMinutes: 480,
          expectedMinutes: 480,
        },
        {
          employeeId: employeeAId,
          type: AbsenceType.VOCATIONAL_SCHOOL,
          source: "MANUAL",
          date: new Date("2026-07-15"),
          workedMinutes: 480,
          expectedMinutes: 480,
        },
      ],
    });
    const result = await loadWorkEventsForRange(app.prisma, employeeAId, RANGE_START, RANGE_END);
    expect(result.workedMinutes).toBe(0);
    expect(result.expectedMinutes).toBe(0);
    expect(result.coveredDates.size).toBe(0);
  });

  // ── Test 11 ────────────────────────────────────────────────────────────────
  it("11. aggregates ALL WorkEvent types — adapter does NOT inline a type filter (PITFALLS.md S-1)", async () => {
    // Today only VOCATIONAL_SCHOOL exists in production data, but the enum
    // reserves FIELD_SERVICE / BUSINESS_TRIP / TRAINING / OTHER for Phase 80+.
    // The adapter MUST NOT add `type: { not: AbsenceType.VOCATIONAL_SCHOOL }` or any
    // similar filter — every future type contributes to the aggregate for free.
    // This test seeds rows of all 5 reserved types and asserts they all count.
    await app.prisma.workEvent.createMany({
      data: [
        {
          employeeId: employeeAId,
          type: AbsenceType.VOCATIONAL_SCHOOL,
          source: "MANUAL",
          date: new Date("2026-06-01"),
          workedMinutes: 100,
          expectedMinutes: 100,
        },
        {
          employeeId: employeeAId,
          type: "FIELD_SERVICE",
          source: "MANUAL",
          date: new Date("2026-06-02"),
          workedMinutes: 200,
          expectedMinutes: 200,
        },
        {
          employeeId: employeeAId,
          type: "BUSINESS_TRIP",
          source: "MANUAL",
          date: new Date("2026-06-03"),
          workedMinutes: 300,
          expectedMinutes: 300,
        },
        {
          employeeId: employeeAId,
          type: "TRAINING",
          source: "MANUAL",
          date: new Date("2026-06-04"),
          workedMinutes: 400,
          expectedMinutes: 400,
        },
        {
          employeeId: employeeAId,
          type: "OTHER",
          source: "MANUAL",
          date: new Date("2026-06-05"),
          workedMinutes: 500,
          expectedMinutes: 500,
        },
      ],
    });
    const result = await loadWorkEventsForRange(app.prisma, employeeAId, RANGE_START, RANGE_END);
    expect(result.workedMinutes).toBe(1500); // 100+200+300+400+500
    expect(result.expectedMinutes).toBe(1500);
    expect(result.coveredDates.size).toBe(5);
  });

  // ── Test 12 ────────────────────────────────────────────────────────────────
  it("12. tenant isolation is endpoint-layer responsibility — adapter does NOT filter tenantId (PITFALLS.md M-3)", async () => {
    // Documents the trust boundary: the adapter accepts an employeeId and
    // trusts the caller to have already scoped it to the calling tenant.
    // If a caller hands the adapter an employeeId from tenant B, the adapter
    // WILL return tenant-B rows — that's by design. Defense-in-depth lives at
    // endpoints (Phase 79) via `employee: { tenantId: req.user.tenantId }`
    // and at saldo callers (Phase 78) which scope by tenant before reaching here.
    await app.prisma.workEvent.create({
      data: {
        employeeId: employeeBId, // tenant B!
        type: AbsenceType.VOCATIONAL_SCHOOL,
        source: "MANUAL",
        date: new Date("2026-06-10"),
        workedMinutes: 480,
        expectedMinutes: 480,
      },
    });
    const result = await loadWorkEventsForRange(app.prisma, employeeBId, RANGE_START, RANGE_END);
    // Adapter returns the row because the caller asked for it by employeeId.
    // Tenant scoping is NOT enforced here — that's a contract decision.
    expect(result.workedMinutes).toBe(480);
    expect(result.expectedMinutes).toBe(480);
    expect(result.coveredDates.has("2026-06-10")).toBe(true);
  });
});

// ── Phase 78 Plan 01 — Compat-branch parity tests ─────────────────────────────
// Per CONTEXT D-06: the 18-scenario matrix (6 base × 3 schedule types) verifies
// that the Absence-branch (legacy tenants, workEventModelLive=false) and the
// WorkEvent-branch (migrated tenants, workEventModelLive=true) produce
// BYTE-identical saldo aggregates for IDENTICAL scenarios. This is the
// compat-layer-equivalence guarantee Phase 78 ships on.
//
// Strict 0-tolerance per D-08 — no soft thresholds.

import {
  getBsMinutesForDate,
  countBsDaysInIsoWeek as adapterCountBsDaysInIsoWeek,
  hasBsOnDate,
  combineBsAndWorkOnSameDay,
  VARIANT_B_MAX_MERGE,
} from "../work-event";
import { AbsenceType } from "@clokr/db";

type ScheduleAxis = "FIXED_SCHEDULE" | "SHIFT_BASED" | "MONTHLY_HOURS";
const SCHEDULE_AXES: ScheduleAxis[] = ["FIXED_SCHEDULE", "SHIFT_BASED", "MONTHLY_HOURS"];

interface ParityTenant {
  tenantId: string;
  employeeId: string;
}

// Common UTC range — June 2026 (half-open).
const P78_RANGE_START = new Date("2026-06-01T00:00:00Z");
const P78_RANGE_END = new Date("2026-07-01T00:00:00Z");

async function seedTenantWithFlag(
  app: FastifyInstance,
  workEventModelLive: boolean,
  scheduleType: ScheduleAxis,
  label: string,
): Promise<ParityTenant> {
  const prisma = app.prisma;
  const s = `p78-${label}-${workEventModelLive ? "live" : "leg"}-${scheduleType}-${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;

  const tenant = await prisma.tenant.create({
    data: { name: `P78 ${s}`, slug: `p78-${s}`.toLowerCase(), federalState: "NIEDERSACHSEN" },
  });
  await prisma.tenantConfig.create({
    data: {
      tenantId: tenant.id,
      defaultVacationDays: 30,
      timezone: "Europe/Berlin",
      vocationalSchoolMinutesPerDay: 480,
      vocationalSchoolBlockMinutesPerWeek: 2400,
      workEventModelLive,
    },
  });
  const user = await prisma.user.create({
    data: {
      email: `${s}@test.de`,
      passwordHash: await bcrypt.hash("test1234", 10),
      role: "EMPLOYEE",
      isActive: true,
    },
  });
  const emp = await prisma.employee.create({
    data: {
      tenantId: tenant.id,
      userId: user.id,
      employeeNumber: `EP-${s}`,
      firstName: "P.",
      lastName: "E.",
      hireDate: new Date("2026-01-01"),
    },
  });
  // Seed the schedule that's valid from hire onwards.
  if (scheduleType === "FIXED_SCHEDULE") {
    await prisma.workSchedule.create({
      data: {
        employeeId: emp.id,
        type: "FIXED_SCHEDULE",
        weeklyHours: 40,
        mondayHours: 8,
        tuesdayHours: 8,
        wednesdayHours: 8,
        thursdayHours: 8,
        fridayHours: 8,
        saturdayHours: 0,
        sundayHours: 0,
        workDays: [1, 2, 3, 4, 5],
        validFrom: new Date("2026-01-01T00:00:00Z"),
      },
    });
  } else if (scheduleType === "SHIFT_BASED") {
    await prisma.workSchedule.create({
      data: {
        employeeId: emp.id,
        type: "SHIFT_BASED",
        weeklyHours: 40,
        mondayHours: 0,
        tuesdayHours: 0,
        wednesdayHours: 0,
        thursdayHours: 0,
        fridayHours: 0,
        saturdayHours: 0,
        sundayHours: 0,
        workDays: [1, 2, 3, 4, 5],
        validFrom: new Date("2026-01-01T00:00:00Z"),
      },
    });
  } else {
    // MONTHLY_HOURS
    await prisma.workSchedule.create({
      data: {
        employeeId: emp.id,
        type: "MONTHLY_HOURS",
        weeklyHours: null,
        monthlyHours: 173,
        mondayHours: 0,
        tuesdayHours: 0,
        wednesdayHours: 0,
        thursdayHours: 0,
        fridayHours: 0,
        saturdayHours: 0,
        sundayHours: 0,
        workDays: [1, 2, 3, 4, 5],
        validFrom: new Date("2026-01-01T00:00:00Z"),
      },
    });
  }
  return { tenantId: tenant.id, employeeId: emp.id };
}

/**
 * Seed BS for a fixture scenario.
 * If writeWorkEvents=true: writes WorkEvent rows directly (Phase 77 path) with
 * workedMinutes/expectedMinutes pre-resolved per Phase 63 D-01..D-04 invariant.
 * If false: writes Absence rows (legacy) — the adapter will compute the doubling.
 */
async function seedBsDays(
  app: FastifyInstance,
  ctx: ParityTenant,
  dates: Date[],
  bsMinPerDay: number,
  scheduleType: ScheduleAxis,
  writeWorkEvents: boolean,
): Promise<void> {
  const prisma = app.prisma;
  if (writeWorkEvents) {
    // Phase 63 D-04: expectedMinutes is NULL for MONTHLY_HOURS, equal to worked for FIXED/SHIFT_BASED.
    const expected = scheduleType === "MONTHLY_HOURS" ? null : bsMinPerDay;
    await prisma.workEvent.createMany({
      data: dates.map((d) => ({
        employeeId: ctx.employeeId,
        type: AbsenceType.VOCATIONAL_SCHOOL,
        source: "MANUAL",
        date: d,
        workedMinutes: bsMinPerDay,
        expectedMinutes: expected,
      })),
    });
  } else {
    // Legacy Absence rows — adapter will compute doubling.
    for (const d of dates) {
      await prisma.absence.create({
        data: {
          employeeId: ctx.employeeId,
          type: AbsenceType.VOCATIONAL_SCHOOL,
          source: "MANUAL",
          startDate: d,
          endDate: d,
          days: 1,
          createdBy: ctx.employeeId,
        },
      });
    }
  }
}

interface BaseScenario {
  name: string;
  dates: Date[]; // BS dates to seed
  bsMinPerDay: number; // tenant-config-based credit per BS day (single=480, block=480 too — adapter caps)
  // After we want assertions, our parity check uses identical strict comparisons.
}

const BASE_SCENARIOS: BaseScenario[] = [
  {
    // 1. single BS day in week
    name: "single BS day in week",
    dates: [new Date("2026-06-01T00:00:00Z")], // Mon
    bsMinPerDay: 480,
  },
  {
    // 2. block week (5 BS days Mo-Fr)
    name: "block week (5 BS days)",
    dates: [
      new Date("2026-06-08T00:00:00Z"),
      new Date("2026-06-09T00:00:00Z"),
      new Date("2026-06-10T00:00:00Z"),
      new Date("2026-06-11T00:00:00Z"),
      new Date("2026-06-12T00:00:00Z"),
    ],
    bsMinPerDay: 480, // block: 2400 / 5 = 480 — same number, identical result either branch
  },
  {
    // 3. BS day + TimeEntry same day — adapter scope only counts BS contribution;
    //    combineBsAndWorkOnSameDay is tested separately. Here parity just checks BS slice.
    name: "BS day + TimeEntry same day (Variante B max-merge)",
    dates: [new Date("2026-06-15T00:00:00Z")],
    bsMinPerDay: 480,
  },
  {
    // 4. BS day in month with locked snapshot context (snapshot is orthogonal to adapter)
    name: "BS day in month with locked snapshot",
    dates: [new Date("2026-06-22T00:00:00Z")],
    bsMinPerDay: 480,
  },
  {
    // 5. BS day at month boundary — June 30 is included, July 1 is excluded.
    name: "BS day at month boundary (UTC vs tenant TZ)",
    dates: [new Date("2026-06-30T00:00:00Z")],
    bsMinPerDay: 480,
  },
  {
    // 6. BS day after schedule-switch (accept-stale per D-12) — same date, no switch
    //    happens in this test scope; parity asserts adapter still produces identical results.
    name: "BS day after schedule-switch (accept-stale per D-12)",
    dates: [new Date("2026-06-29T00:00:00Z")],
    bsMinPerDay: 480,
  },
];

describe("loadWorkEventsForRange — Phase 78 compat-branch parity", () => {
  let app: FastifyInstance;
  beforeAll(async () => {
    app = await getTestApp();
  });
  afterAll(async () => {
    await closeTestApp();
  });

  for (const base of BASE_SCENARIOS) {
    for (const scheduleType of SCHEDULE_AXES) {
      it(`compat-parity: ${base.name} × ${scheduleType}`, async () => {
        // 1. Seed legacy branch (Absence rows, workEventModelLive=false)
        const ctxLegacy = await seedTenantWithFlag(
          app,
          false,
          scheduleType,
          base.name.slice(0, 10),
        );
        await seedBsDays(app, ctxLegacy, base.dates, base.bsMinPerDay, scheduleType, false);
        const resultLegacy = await loadWorkEventsForRange(
          app.prisma,
          ctxLegacy.employeeId,
          P78_RANGE_START,
          P78_RANGE_END,
        );

        // 2. Seed live branch (WorkEvent rows, workEventModelLive=true)
        const ctxLive = await seedTenantWithFlag(app, true, scheduleType, base.name.slice(0, 10));
        await seedBsDays(app, ctxLive, base.dates, base.bsMinPerDay, scheduleType, true);
        const resultLive = await loadWorkEventsForRange(
          app.prisma,
          ctxLive.employeeId,
          P78_RANGE_START,
          P78_RANGE_END,
        );

        // 3. Strict 0-tolerance parity (D-08)
        expect(resultLegacy.workedMinutes).toBe(resultLive.workedMinutes);
        expect(resultLegacy.expectedMinutes).toBe(resultLive.expectedMinutes);
        expect([...resultLegacy.coveredDates].sort()).toEqual([...resultLive.coveredDates].sort());
      });
    }
  }
});

// ── Helper tests (compat-branch parity for arbzg/jarbschg/shifts replacement) ──
describe("getBsMinutesForDate / countBsDaysInIsoWeek / hasBsOnDate — compat-branch parity", () => {
  let app: FastifyInstance;
  beforeAll(async () => {
    app = await getTestApp();
  });
  afterAll(async () => {
    await closeTestApp();
  });

  it("getBsMinutesForDate returns 480 for single BS day (Absence-branch, default config)", async () => {
    const ctx = await seedTenantWithFlag(app, false, "FIXED_SCHEDULE", "h1");
    const date = new Date("2026-06-01T00:00:00Z");
    await seedBsDays(app, ctx, [date], 480, "FIXED_SCHEDULE", false);
    expect(await getBsMinutesForDate(app.prisma, ctx.employeeId, date)).toBe(480);
  });

  it("getBsMinutesForDate returns 480 for single BS day (WorkEvent-branch, workedMinutes=480)", async () => {
    const ctx = await seedTenantWithFlag(app, true, "FIXED_SCHEDULE", "h2");
    const date = new Date("2026-06-01T00:00:00Z");
    await seedBsDays(app, ctx, [date], 480, "FIXED_SCHEDULE", true);
    expect(await getBsMinutesForDate(app.prisma, ctx.employeeId, date)).toBe(480);
  });

  it("countBsDaysInIsoWeek returns 5 for block week (Absence-branch)", async () => {
    const ctx = await seedTenantWithFlag(app, false, "FIXED_SCHEDULE", "h3");
    const dates = [
      new Date("2026-06-08T00:00:00Z"),
      new Date("2026-06-09T00:00:00Z"),
      new Date("2026-06-10T00:00:00Z"),
      new Date("2026-06-11T00:00:00Z"),
      new Date("2026-06-12T00:00:00Z"),
    ];
    await seedBsDays(app, ctx, dates, 480, "FIXED_SCHEDULE", false);
    expect(await adapterCountBsDaysInIsoWeek(app.prisma, ctx.employeeId, dates[0])).toBe(5);
  });

  it("countBsDaysInIsoWeek returns 5 for block week (WorkEvent-branch)", async () => {
    const ctx = await seedTenantWithFlag(app, true, "FIXED_SCHEDULE", "h4");
    const dates = [
      new Date("2026-06-08T00:00:00Z"),
      new Date("2026-06-09T00:00:00Z"),
      new Date("2026-06-10T00:00:00Z"),
      new Date("2026-06-11T00:00:00Z"),
      new Date("2026-06-12T00:00:00Z"),
    ];
    await seedBsDays(app, ctx, dates, 480, "FIXED_SCHEDULE", true);
    expect(await adapterCountBsDaysInIsoWeek(app.prisma, ctx.employeeId, dates[0])).toBe(5);
  });

  it("hasBsOnDate returns true for BS day (Absence-branch)", async () => {
    const ctx = await seedTenantWithFlag(app, false, "FIXED_SCHEDULE", "h5");
    const date = new Date("2026-06-01T00:00:00Z");
    await seedBsDays(app, ctx, [date], 480, "FIXED_SCHEDULE", false);
    expect(await hasBsOnDate(app.prisma, ctx.employeeId, date)).toBe(true);
  });

  it("hasBsOnDate returns true for BS day (WorkEvent-branch)", async () => {
    const ctx = await seedTenantWithFlag(app, true, "FIXED_SCHEDULE", "h6");
    const date = new Date("2026-06-01T00:00:00Z");
    await seedBsDays(app, ctx, [date], 480, "FIXED_SCHEDULE", true);
    expect(await hasBsOnDate(app.prisma, ctx.employeeId, date)).toBe(true);
  });

  it("hasBsOnDate returns false when WorkEvent is soft-deleted", async () => {
    const ctx = await seedTenantWithFlag(app, true, "FIXED_SCHEDULE", "h7");
    const date = new Date("2026-06-01T00:00:00Z");
    await app.prisma.workEvent.create({
      data: {
        employeeId: ctx.employeeId,
        type: AbsenceType.VOCATIONAL_SCHOOL,
        source: "MANUAL",
        date,
        workedMinutes: 480,
        expectedMinutes: 480,
        deletedAt: new Date("2026-06-02T10:00:00Z"),
      },
    });
    expect(await hasBsOnDate(app.prisma, ctx.employeeId, date)).toBe(false);
  });
});

// ── D-11: combineBsAndWorkOnSameDay (Variante B max-merge) ──────────────────
describe("combineBsAndWorkOnSameDay (D-11 Variante B max-merge)", () => {
  it("VARIANT_B_MAX_MERGE === true (D-11 locked default)", () => {
    expect(VARIANT_B_MAX_MERGE).toBe(true);
  });

  it("returns max(pauschal, instruction+work) when VARIANT_B_MAX_MERGE", () => {
    expect(combineBsAndWorkOnSameDay(480, 0, 0)).toBe(480);
  });

  it("Scenario B: pauschal=480 wins over instruction=120 + work=180 → 480", () => {
    // Azubi: 2h BS lesson + 3h Nachmittagsarbeit = 5h < 8h pauschal
    expect(combineBsAndWorkOnSameDay(480, 120, 180)).toBe(480);
  });

  it("long-work scenario: instruction=240 + work=300 (=540) wins over pauschal=480 → 540", () => {
    expect(combineBsAndWorkOnSameDay(480, 240, 300)).toBe(540);
  });
});

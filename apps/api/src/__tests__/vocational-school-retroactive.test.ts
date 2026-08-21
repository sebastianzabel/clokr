// Phase 103 — Rückwirkende Berufsschul-Musteränderungen: generator window + routes.
//
// Tracer slice tests. Task 1 covers the shared generator's explicit window +
// single-employee scoping (Tests 1-8 below). Task 2 extends this same file with the
// two new route handlers (Tests 9-15).
//
// Mirrors the harness conventions of vocational-school.test.ts. This feature's entire
// domain is past dates, so every date helper below reasons BACKWARD from "now" — the
// mirror image of that file's forward-only nextDow(). Never hardcode an absolute
// calendar date anywhere in this file (including comments): this project has a
// documented history of date-hardcoded tests turning into silent time bombs once
// "today" moves past them.

import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import { getTestApp, closeTestApp, seedTestData, cleanupTestData } from "./setup";
import type { FastifyInstance } from "fastify";
import {
  runVocationalSchoolGeneration,
  previewVocationalSchoolGeneration,
  resolveRetroactiveWindow,
} from "../utils/vocational-school-generator";

// ── Date helpers — mirror-image of nextDow() in vocational-school.test.ts ──────────

/** UTC midnight for "today". */
function todayUtc(): Date {
  const d = new Date();
  d.setUTCHours(0, 0, 0, 0);
  return d;
}

/** `n` days before today, UTC midnight. */
function daysAgoUtc(n: number): Date {
  const d = todayUtc();
  d.setUTCDate(d.getUTCDate() - n);
  return d;
}

function toIso(d: Date): string {
  return d.toISOString().slice(0, 10);
}

/** UTC 00:00 of the 1st of `d`'s month. Mirrors the generator's own internal helper. */
function monthStartUtc(d: Date): Date {
  return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), 1));
}

/** UTC 00:00 of the last day of `d`'s month. */
function monthEndUtc(d: Date): Date {
  return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 0));
}

let extraEmployeeSeq = 0;

/**
 * Create an additional employee in an existing tenant, for tests that need more than
 * the one seedTestData() already provides (employee-scoping proofs, cross-tenant IDOR
 * checks). No real password hashing — these rows are never used to log in within this
 * file's own tests (Task 2's cross-tenant test authenticates as tenant A's admin only).
 */
async function createExtraEmployee(
  app: FastifyInstance,
  tenantId: string,
  opts: { classification?: "AZUBI" | "VOLLZEIT" } = {},
) {
  extraEmployeeSeq += 1;
  const s = `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}-${extraEmployeeSeq}`;
  const user = await app.prisma.user.create({
    data: {
      email: `bs-retro-${s}@test.de`,
      passwordHash: "unused-not-logged-in",
      role: "EMPLOYEE",
      isActive: true,
    },
  });
  const employee = await app.prisma.employee.create({
    data: {
      tenantId,
      userId: user.id,
      employeeNumber: `BSR-${s}`,
      firstName: "BS",
      lastName: "Retro",
      hireDate: daysAgoUtc(365 * 5), // safely before any window used in this file
      classification: opts.classification ?? "AZUBI",
    },
  });
  return { user, employee };
}

describe("Berufsschule — rückwirkende Musteränderungen (Phase 103, Tracer)", () => {
  let app: FastifyInstance;
  let data: Awaited<ReturnType<typeof seedTestData>>;

  beforeAll(async () => {
    app = await getTestApp();
    data = await seedTestData(app, "vsretro");
  });

  afterAll(async () => {
    try {
      await cleanupTestData(app, data.tenant.id);
    } catch (err) {
      console.error("Test cleanup failed:", err);
    }
    await closeTestApp();
  });

  // Wipe phase-specific state between tests so each one starts from a clean slate,
  // mirroring vocational-school.test.ts's beforeEach exactly.
  beforeEach(async () => {
    await app.prisma.employeeVocationalSchoolPattern.deleteMany({
      where: { employeeId: data.employee.id },
    });
    await app.prisma.absence.deleteMany({
      where: { employeeId: data.employee.id },
    });
    await app.prisma.saldoSnapshot.deleteMany({
      where: { employeeId: data.employee.id },
    });
  });

  it("Setup invariant — a freshly seeded synthetic employee has no SaldoSnapshot (past-dated seeds are therefore not locked by default)", async () => {
    const count = await app.prisma.saldoSnapshot.count({
      where: { employeeId: data.employee.id },
    });
    expect(count).toBe(0);
  });

  // ── Test 1 — backward compat ────────────────────────────────────────────────

  it("Test 1 — backward compat: default opts (no window/employeeId) produce the identical created count and date set as before, weeksAhead*7+1 iterations", async () => {
    await app.prisma.employeeVocationalSchoolPattern.create({
      data: {
        employeeId: data.employee.id,
        dayOfWeek: 1,
        daysOfWeek: [1], // Tuesday
        blockWeeks: [],
        validFrom: daysAgoUtc(365 * 5),
        isActive: true,
      },
    });

    const weeksAhead = 4;
    const result = await previewVocationalSchoolGeneration(app.prisma, {
      tenantId: data.tenant.id,
      employeeId: data.employee.id,
      weeksAhead,
    });

    const today = todayUtc();
    const expectedDates: string[] = [];
    for (let i = 0; i <= weeksAhead * 7; i++) {
      const d = new Date(today.getTime());
      d.setUTCDate(d.getUTCDate() + i);
      const native = d.getUTCDay();
      const dow = native === 0 ? 6 : native - 1;
      if (dow === 1) expectedDates.push(toIso(d));
    }

    expect(result.created).toBe(expectedDates.length);
    const actualDates = (result.details ?? [])
      .filter((entry) => entry.action === "created")
      .map((entry) => entry.date)
      .sort();
    expect(actualDates).toEqual(expectedDates.sort());
  });

  // ── Test 2 — D-03 reach ─────────────────────────────────────────────────────

  it("Test 2 — D-03 reach: explicit windowStart creates past BS days; without it, none of those past days are created", async () => {
    const past = daysAgoUtc(8 * 7);
    await app.prisma.employeeVocationalSchoolPattern.create({
      data: {
        employeeId: data.employee.id,
        dayOfWeek: 1,
        daysOfWeek: [1], // Tuesday
        blockWeeks: [],
        validFrom: past,
        isActive: true,
      },
    });
    const today = todayUtc();
    const todayIso = toIso(today);

    const withoutWindow = await previewVocationalSchoolGeneration(app.prisma, {
      tenantId: data.tenant.id,
      employeeId: data.employee.id,
    });
    const pastCreatedWithout = (withoutWindow.details ?? []).filter(
      (entry) => entry.action === "created" && entry.date < todayIso,
    );
    expect(pastCreatedWithout).toHaveLength(0);

    const withWindow = await previewVocationalSchoolGeneration(app.prisma, {
      tenantId: data.tenant.id,
      employeeId: data.employee.id,
      windowStart: past,
      windowEnd: today,
    });
    const pastCreatedWith = (withWindow.details ?? []).filter(
      (entry) => entry.action === "created" && entry.date < todayIso,
    );
    expect(pastCreatedWith.length).toBeGreaterThan(0);
  });

  // ── Test 3 — D-03 no shift ──────────────────────────────────────────────────

  it("Test 3 — D-03 no shift: validFrom is byte-identical before and after an apply run", async () => {
    const past = daysAgoUtc(6 * 7);
    const pattern = await app.prisma.employeeVocationalSchoolPattern.create({
      data: {
        employeeId: data.employee.id,
        dayOfWeek: 3,
        daysOfWeek: [3], // Thursday
        blockWeeks: [],
        validFrom: past,
        isActive: true,
      },
    });
    const before = pattern.validFrom.getTime();

    await runVocationalSchoolGeneration(app.prisma, app.audit, {
      tenantId: data.tenant.id,
      employeeId: data.employee.id,
      windowStart: past,
      windowEnd: todayUtc(),
    });

    const after = await app.prisma.employeeVocationalSchoolPattern.findUniqueOrThrow({
      where: { id: pattern.id },
    });
    expect(after.validFrom.getTime()).toBe(before);
  });

  // ── Test 4 — employee scoping ───────────────────────────────────────────────

  it("Test 4 — employee scoping: a run with employeeId: A creates rows only for A, never for B", async () => {
    const past = daysAgoUtc(6 * 7);
    const { employee: employeeA } = await createExtraEmployee(app, data.tenant.id);
    const { employee: employeeB } = await createExtraEmployee(app, data.tenant.id);

    await app.prisma.employeeVocationalSchoolPattern.create({
      data: {
        employeeId: employeeA.id,
        dayOfWeek: 0,
        daysOfWeek: [0], // Monday
        blockWeeks: [],
        validFrom: past,
        isActive: true,
      },
    });
    await app.prisma.employeeVocationalSchoolPattern.create({
      data: {
        employeeId: employeeB.id,
        dayOfWeek: 0,
        daysOfWeek: [0], // Monday — same weekday, different employee
        blockWeeks: [],
        validFrom: past,
        isActive: true,
      },
    });

    const preview = await previewVocationalSchoolGeneration(app.prisma, {
      tenantId: data.tenant.id,
      employeeId: employeeA.id,
      windowStart: past,
      windowEnd: todayUtc(),
    });
    expect(preview.created).toBeGreaterThan(0);
    for (const entry of preview.details ?? []) {
      expect(entry.employeeId).toBe(employeeA.id);
    }

    const apply = await runVocationalSchoolGeneration(app.prisma, app.audit, {
      tenantId: data.tenant.id,
      employeeId: employeeA.id,
      windowStart: past,
      windowEnd: todayUtc(),
    });
    expect(apply.created).toBeGreaterThan(0);

    const aCount = await app.prisma.absence.count({
      where: { employeeId: employeeA.id, deletedAt: null },
    });
    const bCount = await app.prisma.absence.count({
      where: { employeeId: employeeB.id, deletedAt: null },
    });
    expect(aCount).toBeGreaterThan(0);
    expect(bCount).toBe(0);
  });

  // ── Test 5 — preview == apply parity ────────────────────────────────────────

  it("Test 5 — preview == apply parity: identical created count, preview's date set equals the Absences that actually exist after apply", async () => {
    const past = daysAgoUtc(5 * 7);
    await app.prisma.employeeVocationalSchoolPattern.create({
      data: {
        employeeId: data.employee.id,
        dayOfWeek: 2,
        daysOfWeek: [2], // Wednesday
        blockWeeks: [],
        validFrom: past,
        isActive: true,
      },
    });
    const today = todayUtc();

    const preview = await previewVocationalSchoolGeneration(app.prisma, {
      tenantId: data.tenant.id,
      employeeId: data.employee.id,
      windowStart: past,
      windowEnd: today,
    });
    const previewDates = (preview.details ?? [])
      .filter((entry) => entry.action === "created")
      .map((entry) => entry.date)
      .sort();

    const apply = await runVocationalSchoolGeneration(app.prisma, app.audit, {
      tenantId: data.tenant.id,
      employeeId: data.employee.id,
      windowStart: past,
      windowEnd: today,
    });
    expect(apply.created).toBe(preview.created);

    const created = await app.prisma.absence.findMany({
      where: { employeeId: data.employee.id, type: "VOCATIONAL_SCHOOL", deletedAt: null },
      select: { startDate: true },
    });
    const createdDates = created.map((a) => toIso(a.startDate)).sort();
    expect(createdDates).toEqual(previewDates);
  });

  // ── Test 6 — preview writes nothing ─────────────────────────────────────────

  it("Test 6 — preview writes nothing: zero Absence rows and unchanged AuditLog count after a preview call", async () => {
    const past = daysAgoUtc(4 * 7);
    await app.prisma.employeeVocationalSchoolPattern.create({
      data: {
        employeeId: data.employee.id,
        dayOfWeek: 4,
        daysOfWeek: [4], // Friday
        blockWeeks: [],
        validFrom: past,
        isActive: true,
      },
    });

    const auditCountBefore = await app.prisma.auditLog.count({ where: { entity: "Absence" } });

    const preview = await previewVocationalSchoolGeneration(app.prisma, {
      tenantId: data.tenant.id,
      employeeId: data.employee.id,
      windowStart: past,
      windowEnd: todayUtc(),
    });
    expect(preview.created).toBeGreaterThan(0); // sanity: there is something to preview

    const absenceCount = await app.prisma.absence.count({
      where: { employeeId: data.employee.id },
    });
    expect(absenceCount).toBe(0);

    const auditCountAfter = await app.prisma.auditLog.count({ where: { entity: "Absence" } });
    expect(auditCountAfter).toBe(auditCountBefore);
  });

  // ── Test 7 — T-103-LOCK ─────────────────────────────────────────────────────

  it("Test 7 — T-103-LOCK: a real apply run creates zero Absence rows in a locked month, counts them in skipped.locked, and still creates the remaining months", async () => {
    const past = daysAgoUtc(95); // spans multiple calendar months
    const today = todayUtc();
    await app.prisma.employeeVocationalSchoolPattern.create({
      data: {
        employeeId: data.employee.id,
        dayOfWeek: 0,
        daysOfWeek: [0], // Monday
        blockWeeks: [],
        validFrom: past,
        isActive: true,
      },
    });

    const lockedAnchor = daysAgoUtc(40);
    const lockMonthStart = monthStartUtc(lockedAnchor);
    const lockMonthEnd = monthEndUtc(lockedAnchor);
    await app.prisma.saldoSnapshot.create({
      data: {
        employeeId: data.employee.id,
        periodType: "MONTHLY",
        periodStart: lockMonthStart,
        periodEnd: lockMonthEnd,
        workedMinutes: 0,
        expectedMinutes: 0,
        balanceMinutes: 0,
        carryOver: 0,
        closedAt: new Date(),
      },
    });

    const result = await runVocationalSchoolGeneration(app.prisma, app.audit, {
      tenantId: data.tenant.id,
      employeeId: data.employee.id,
      windowStart: past,
      windowEnd: today,
    });

    expect(result.skipped.locked).toBeGreaterThan(0);
    expect(result.created).toBeGreaterThan(0); // the rest of the window still ran through

    const inLockedMonth = await app.prisma.absence.findMany({
      where: {
        employeeId: data.employee.id,
        type: "VOCATIONAL_SCHOOL",
        startDate: { gte: lockMonthStart, lte: lockMonthEnd },
        deletedAt: null,
      },
    });
    expect(inLockedMonth).toHaveLength(0);
  });

  // ── Test 8 — degenerate window ──────────────────────────────────────────────

  it("Test 8 — degenerate window: windowEnd < windowStart returns the zero-result object and performs no writes", async () => {
    const start = todayUtc();
    const end = daysAgoUtc(5); // end strictly before start

    const before = await app.prisma.absence.count({ where: { employeeId: data.employee.id } });

    const result = await runVocationalSchoolGeneration(app.prisma, app.audit, {
      tenantId: data.tenant.id,
      employeeId: data.employee.id,
      windowStart: start,
      windowEnd: end,
    });

    expect(result.created).toBe(0);
    expect(result.skipped).toEqual({
      schoolHoliday: 0,
      existing: 0,
      locked: 0,
      preHire: 0,
      postExit: 0,
      outOfWindow: 0,
    });

    const after = await app.prisma.absence.count({ where: { employeeId: data.employee.id } });
    expect(after).toBe(before);
  });

  // ── resolveRetroactiveWindow — direct coverage ──────────────────────────────
  // This is the ONLY place the retroactive window is derived server-side
  // (T-103-WINDOW). Covered directly here in addition to the route-level tests in
  // Task 2 because it carries its own selection logic (MIN across active patterns).

  it("resolveRetroactiveWindow — returns null when no active pattern has a past validFrom", async () => {
    await app.prisma.employeeVocationalSchoolPattern.create({
      data: {
        employeeId: data.employee.id,
        dayOfWeek: 1,
        daysOfWeek: [1],
        blockWeeks: [],
        validFrom: new Date(todayUtc().getTime() + 30 * 86_400_000), // future-dated only
        isActive: true,
      },
    });

    const window = await resolveRetroactiveWindow(app.prisma, {
      tenantId: data.tenant.id,
      employeeId: data.employee.id,
    });
    expect(window).toBeNull();
  });

  it("resolveRetroactiveWindow — returns the earliest validFrom across multiple active past-dated patterns", async () => {
    // Two simultaneously-active rows (isActive: true) model the Musterhistorie
    // anomaly documented in 103-BEFUND.md — not fixed by this plan, but
    // resolveRetroactiveWindow must still behave sanely (take the earliest) when it
    // occurs, rather than picking an arbitrary one.
    const older = daysAgoUtc(10 * 7);
    const newer = daysAgoUtc(3 * 7);
    await app.prisma.employeeVocationalSchoolPattern.create({
      data: {
        employeeId: data.employee.id,
        dayOfWeek: 1,
        daysOfWeek: [1],
        blockWeeks: [],
        validFrom: older,
        isActive: true,
      },
    });
    await app.prisma.employeeVocationalSchoolPattern.create({
      data: {
        employeeId: data.employee.id,
        dayOfWeek: 2,
        daysOfWeek: [2],
        blockWeeks: [],
        validFrom: newer,
        isActive: true,
      },
    });

    const window = await resolveRetroactiveWindow(app.prisma, {
      tenantId: data.tenant.id,
      employeeId: data.employee.id,
    });
    expect(window).not.toBeNull();
    expect(window!.windowStart.getTime()).toBe(older.getTime());
    expect(window!.windowEnd.getTime()).toBe(todayUtc().getTime());
  });
});

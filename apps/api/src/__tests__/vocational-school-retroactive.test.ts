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

// Route paths under test (Task 2). Referenced as a template fragment rather than
// repeated literals so there is exactly one place that would need updating if the
// prefix ever changes.
const BASE = "/api/v1/vocational-school";

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
  // Task 2 — second tenant for the T-103-IDOR cross-tenant test, mirroring the
  // otherTenantData convention in vocational-school-endpoints.test.ts.
  let otherTenantData: Awaited<ReturnType<typeof seedTestData>>;

  beforeAll(async () => {
    app = await getTestApp();
    data = await seedTestData(app, "vsretro");
    otherTenantData = await seedTestData(app, "vsretro-other");
  });

  afterAll(async () => {
    try {
      await cleanupTestData(app, data.tenant.id);
    } catch (err) {
      console.error("Test cleanup failed (data):", err);
    }
    try {
      await cleanupTestData(app, otherTenantData.tenant.id);
    } catch (err) {
      console.error("Test cleanup failed (otherTenantData):", err);
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
    expect(result.removed).toBe(0);
    expect(result.skipped).toEqual({
      schoolHoliday: 0,
      existing: 0,
      locked: 0,
      preHire: 0,
      postExit: 0,
      outOfWindow: 0,
      removalLocked: 0,
      timeEntryConflict: 0,
    });

    const after = await app.prisma.absence.count({ where: { employeeId: data.employee.id } });
    expect(after).toBe(before);
  });

  // ── Task 1 — orphan-sweep removal reporting (D-02/D-04) ────────────────────
  // A preview must be a true dry run of BOTH directions of the diff, not just the
  // create side, and a locked-month removal skip must be counted/reported instead of
  // silently dropped.

  /** Map JS-native getUTCDay onto the schema's Mo-based convention (0=Mo..6=So). */
  function mondayBasedDow(d: Date): number {
    const native = d.getUTCDay();
    return native === 0 ? 6 : native - 1;
  }

  it("Test 16 — D-02/D-04 removal split: preview reports removed + removalLocked without writing; apply soft-deletes the open-month orphan, leaves the locked-month orphan untouched", async () => {
    const anchorLocked = daysAgoUtc(40); // will be locked below
    const anchorOpen = daysAgoUtc(10); // stays open
    const windowStart = daysAgoUtc(45);
    const today = todayUtc();

    // Two tightly-scoped patterns, each producing exactly ONE Absence at its own
    // anchor date (validFrom === validUntil === anchor, daysOfWeek derived from the
    // anchor's own weekday so no weekday-rounding is needed).
    const patternLocked = await app.prisma.employeeVocationalSchoolPattern.create({
      data: {
        employeeId: data.employee.id,
        dayOfWeek: mondayBasedDow(anchorLocked),
        daysOfWeek: [mondayBasedDow(anchorLocked)],
        blockWeeks: [],
        validFrom: anchorLocked,
        validUntil: anchorLocked,
        isActive: true,
      },
    });
    const patternOpen = await app.prisma.employeeVocationalSchoolPattern.create({
      data: {
        employeeId: data.employee.id,
        dayOfWeek: mondayBasedDow(anchorOpen),
        daysOfWeek: [mondayBasedDow(anchorOpen)],
        blockWeeks: [],
        validFrom: anchorOpen,
        validUntil: anchorOpen,
        isActive: true,
      },
    });

    const firstRun = await runVocationalSchoolGeneration(app.prisma, app.audit, {
      tenantId: data.tenant.id,
      employeeId: data.employee.id,
      windowStart,
      windowEnd: today,
    });
    expect(firstRun.created).toBe(2);

    // Lock the month containing anchorLocked — AFTER the row already exists in it,
    // mirroring the real sequence (generated optimistically, month closes later).
    const lockMonthStart = monthStartUtc(anchorLocked);
    const lockMonthEnd = monthEndUtc(anchorLocked);
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

    // Orphan BOTH rows by flipping each pattern's weekday away from its own anchor's
    // weekday — validFrom/validUntil stay untouched so the pattern remains inside the
    // top-level query window (moving it out of the window entirely would drop
    // patterns.length to 0 and short-circuit the whole function before the orphan
    // sweep ever runs). With validFrom === validUntil === anchor, this is the only
    // date either pattern could ever have claimed — flipping the weekday means it no
    // longer claims it, without claiming any other date either.
    await app.prisma.employeeVocationalSchoolPattern.update({
      where: { id: patternLocked.id },
      data: {
        dayOfWeek: (mondayBasedDow(anchorLocked) + 1) % 7,
        daysOfWeek: [(mondayBasedDow(anchorLocked) + 1) % 7],
      },
    });
    await app.prisma.employeeVocationalSchoolPattern.update({
      where: { id: patternOpen.id },
      data: {
        dayOfWeek: (mondayBasedDow(anchorOpen) + 1) % 7,
        daysOfWeek: [(mondayBasedDow(anchorOpen) + 1) % 7],
      },
    });

    // Preview: reports the split, writes nothing.
    const preview = await previewVocationalSchoolGeneration(app.prisma, {
      tenantId: data.tenant.id,
      employeeId: data.employee.id,
      windowStart,
      windowEnd: today,
    });
    expect(preview.removed).toBe(1);
    expect(preview.skipped.removalLocked).toBe(1);
    const removedDetails = (preview.details ?? []).filter((e) => e.action === "removed");
    expect(removedDetails.map((e) => e.date)).toEqual([toIso(anchorOpen)]);
    const lockedSkipDetails = (preview.details ?? []).filter(
      (e) => e.action === "skipped" && e.reason === "removalLocked",
    );
    expect(lockedSkipDetails.map((e) => e.date)).toEqual([toIso(anchorLocked)]);

    const afterPreview = await app.prisma.absence.findMany({
      where: { employeeId: data.employee.id, type: "VOCATIONAL_SCHOOL" },
      select: { deletedAt: true },
    });
    expect(afterPreview.every((a) => a.deletedAt === null)).toBe(true);

    // Apply: identical split (D-01 parity), this time a real write.
    const apply = await runVocationalSchoolGeneration(app.prisma, app.audit, {
      tenantId: data.tenant.id,
      employeeId: data.employee.id,
      windowStart,
      windowEnd: today,
    });
    expect(apply.removed).toBe(preview.removed);
    expect(apply.skipped.removalLocked).toBe(preview.skipped.removalLocked);

    const lockedRow = await app.prisma.absence.findFirst({
      where: { employeeId: data.employee.id, startDate: anchorLocked },
    });
    expect(lockedRow).not.toBeNull();
    expect(lockedRow!.deletedAt).toBeNull(); // no write into a closed month, ever

    const openRow = await app.prisma.absence.findFirst({
      where: { employeeId: data.employee.id, startDate: anchorOpen },
    });
    expect(openRow).not.toBeNull();
    expect(openRow!.deletedAt).not.toBeNull(); // soft-deleted — row still EXISTS (no hard delete)
  });

  it("Test 17 — MANUAL BS absences are never treated as orphans: not counted in removed, never soft-deleted, in either mode", async () => {
    const manualAnchor = daysAgoUtc(20);
    const windowStart = daysAgoUtc(25);
    const today = todayUtc();

    await app.prisma.absence.create({
      data: {
        employeeId: data.employee.id,
        type: "VOCATIONAL_SCHOOL",
        source: "MANUAL",
        startDate: manualAnchor,
        endDate: manualAnchor,
        days: 1.0,
        createdBy: "test",
      },
    });

    // At least one active pattern is required for the orphan sweep to run at all
    // (patterns.length === 0 short-circuits the whole function) — give it a window
    // that never touches manualAnchor.
    await app.prisma.employeeVocationalSchoolPattern.create({
      data: {
        employeeId: data.employee.id,
        dayOfWeek: mondayBasedDow(today),
        daysOfWeek: [mondayBasedDow(today)],
        blockWeeks: [],
        validFrom: today,
        isActive: true,
      },
    });

    const preview = await previewVocationalSchoolGeneration(app.prisma, {
      tenantId: data.tenant.id,
      employeeId: data.employee.id,
      windowStart,
      windowEnd: today,
    });
    expect(preview.removed).toBe(0);
    expect((preview.details ?? []).some((e) => e.date === toIso(manualAnchor))).toBe(false);

    const apply = await runVocationalSchoolGeneration(app.prisma, app.audit, {
      tenantId: data.tenant.id,
      employeeId: data.employee.id,
      windowStart,
      windowEnd: today,
    });
    expect(apply.removed).toBe(0);

    const manualRow = await app.prisma.absence.findFirst({
      where: { employeeId: data.employee.id, startDate: manualAnchor },
    });
    expect(manualRow).not.toBeNull();
    expect(manualRow!.deletedAt).toBeNull();
  });

  it("Test 18 — backward compat: a forward-only preview (no explicit window) reports removed: 0 for a pattern set with no orphans", async () => {
    await app.prisma.employeeVocationalSchoolPattern.create({
      data: {
        employeeId: data.employee.id,
        dayOfWeek: 1,
        daysOfWeek: [1],
        blockWeeks: [],
        validFrom: daysAgoUtc(365 * 5),
        isActive: true,
      },
    });

    const preview = await previewVocationalSchoolGeneration(app.prisma, {
      tenantId: data.tenant.id,
      employeeId: data.employee.id,
    });
    expect(preview.removed).toBe(0);
    expect(preview.skipped.removalLocked).toBe(0);
  });

  // ── Task 2 — TimeEntry conflict detection + overrideDates (D-05/D-06/D-07) ─
  // Branch order under test throughout this section: existing → locked →
  // timeEntryConflict → create (T-103-OVERRIDE). `overrideDates` bypasses ONLY the
  // timeEntryConflict check.

  /** Create a non-deleted WORK TimeEntry for `date` that will conflict with a BS day. */
  async function createConflictingTimeEntry(
    date: Date,
    opts: { isInvalid?: boolean; deletedAt?: Date } = {},
  ) {
    return app.prisma.timeEntry.create({
      data: {
        employeeId: data.employee.id,
        date,
        startTime: new Date(date.getTime() + 8 * 3_600_000),
        endTime: new Date(date.getTime() + 16 * 3_600_000),
        breakMinutes: 0,
        source: "MANUAL",
        type: "WORK",
        isInvalid: opts.isInvalid ?? false,
        deletedAt: opts.deletedAt ?? null,
      },
    });
  }

  /** A single-day pattern: claims exactly `date` (validFrom === validUntil === date). */
  async function createSingleDayPattern(date: Date) {
    return app.prisma.employeeVocationalSchoolPattern.create({
      data: {
        employeeId: data.employee.id,
        dayOfWeek: mondayBasedDow(date),
        daysOfWeek: [mondayBasedDow(date)],
        blockWeeks: [],
        validFrom: date,
        validUntil: date,
        isActive: true,
      },
    });
  }

  it("Test 19 — D-05: a TimeEntry conflict is reported as skipped and produces no Absence, in both preview and apply", async () => {
    const anchor = daysAgoUtc(15);
    const windowStart = daysAgoUtc(20);
    const today = todayUtc();

    await createSingleDayPattern(anchor);
    await createConflictingTimeEntry(anchor);

    const preview = await previewVocationalSchoolGeneration(app.prisma, {
      tenantId: data.tenant.id,
      employeeId: data.employee.id,
      windowStart,
      windowEnd: today,
    });
    expect(preview.created).toBe(0);
    expect(preview.skipped.timeEntryConflict).toBe(1);
    // Note: the pattern's weekday recurs weekly across the window (validFrom ===
    // validUntil only bounds which occurrence is CLAIMED, not which are ITERATED —
    // the other same-weekday dates in-window surface as `outOfWindow` skips), so
    // filter for the specific conflict entry rather than asserting the whole array.
    const conflictEntries = (preview.details ?? []).filter((e) => e.reason === "timeEntryConflict");
    expect(conflictEntries).toEqual([
      {
        employeeId: data.employee.id,
        date: toIso(anchor),
        action: "skipped",
        reason: "timeEntryConflict",
      },
    ]);

    const apply = await runVocationalSchoolGeneration(app.prisma, app.audit, {
      tenantId: data.tenant.id,
      employeeId: data.employee.id,
      windowStart,
      windowEnd: today,
    });
    expect(apply.created).toBe(0);
    expect(apply.skipped.timeEntryConflict).toBe(1);

    const absence = await app.prisma.absence.findFirst({
      where: { employeeId: data.employee.id, startDate: anchor },
    });
    expect(absence).toBeNull();
  });

  it("Test 20 — D-07 default: apply with no overrideDates creates nothing for the conflict day and leaves the TimeEntry completely unmodified", async () => {
    const anchor = daysAgoUtc(12);
    const windowStart = daysAgoUtc(16);
    const today = todayUtc();

    await createSingleDayPattern(anchor);
    const entry = await createConflictingTimeEntry(anchor);

    await runVocationalSchoolGeneration(app.prisma, app.audit, {
      tenantId: data.tenant.id,
      employeeId: data.employee.id,
      windowStart,
      windowEnd: today,
    });

    const after = await app.prisma.timeEntry.findUniqueOrThrow({ where: { id: entry.id } });
    expect(after).toEqual(entry);
  });

  it("Test 21 — D-06 override: overrideDates creates the BS day despite the conflict; the TimeEntry stays unmodified; timeEntryConflict is 0 for that date", async () => {
    const anchor = daysAgoUtc(11);
    const windowStart = daysAgoUtc(16);
    const today = todayUtc();

    await createSingleDayPattern(anchor);
    const entry = await createConflictingTimeEntry(anchor);

    const apply = await runVocationalSchoolGeneration(app.prisma, app.audit, {
      tenantId: data.tenant.id,
      employeeId: data.employee.id,
      windowStart,
      windowEnd: today,
      overrideDates: [toIso(anchor)],
    });
    expect(apply.created).toBe(1);
    expect(apply.skipped.timeEntryConflict).toBe(0);

    const absence = await app.prisma.absence.findFirst({
      where: { employeeId: data.employee.id, startDate: anchor },
    });
    expect(absence).not.toBeNull();
    expect(absence!.type).toBe("VOCATIONAL_SCHOOL");

    const after = await app.prisma.timeEntry.findUniqueOrThrow({ where: { id: entry.id } });
    expect(after).toEqual(entry);
  });

  it("Test 22 — an isInvalid TimeEntry is treated as a conflict exactly like a valid one", async () => {
    const anchor = daysAgoUtc(9);
    const windowStart = daysAgoUtc(14);
    const today = todayUtc();

    await createSingleDayPattern(anchor);
    await createConflictingTimeEntry(anchor, { isInvalid: true });

    const result = await runVocationalSchoolGeneration(app.prisma, app.audit, {
      tenantId: data.tenant.id,
      employeeId: data.employee.id,
      windowStart,
      windowEnd: today,
    });
    expect(result.skipped.timeEntryConflict).toBe(1);
    expect(result.created).toBe(0);
  });

  it("Test 23 — a soft-deleted TimeEntry is NOT a conflict — the day is created normally", async () => {
    const anchor = daysAgoUtc(8);
    const windowStart = daysAgoUtc(13);
    const today = todayUtc();

    await createSingleDayPattern(anchor);
    await createConflictingTimeEntry(anchor, { deletedAt: new Date() });

    const result = await runVocationalSchoolGeneration(app.prisma, app.audit, {
      tenantId: data.tenant.id,
      employeeId: data.employee.id,
      windowStart,
      windowEnd: today,
    });
    expect(result.skipped.timeEntryConflict).toBe(0);
    expect(result.created).toBe(1);
  });

  it("Test 24 — T-103-OVERRIDE: a locked-month date listed in overrideDates is still skipped as locked and creates nothing", async () => {
    const anchor = daysAgoUtc(45);
    const windowStart = daysAgoUtc(50);
    const today = todayUtc();

    await createSingleDayPattern(anchor);
    await createConflictingTimeEntry(anchor);

    const lockMonthStart = monthStartUtc(anchor);
    const lockMonthEnd = monthEndUtc(anchor);
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
      windowStart,
      windowEnd: today,
      overrideDates: [toIso(anchor)],
    });
    expect(result.skipped.locked).toBe(1);
    expect(result.skipped.timeEntryConflict).toBe(0); // locked wins first — never reached
    expect(result.created).toBe(0);

    const absence = await app.prisma.absence.findFirst({
      where: { employeeId: data.employee.id, startDate: anchor },
    });
    expect(absence).toBeNull();
  });

  it("Test 25 — T-103-OVERRIDE: overrideDates for a date outside the window or unclaimed by any pattern creates nothing", async () => {
    const today = todayUtc();
    const windowStart = daysAgoUtc(5);
    const outsideWindowDate = daysAgoUtc(7); // strictly before windowStart
    const unclaimedDate = daysAgoUtc(3); // inside the window, but no pattern targets it

    // At least one active pattern is required for the sweep to run at all. Its target
    // weekday is offset +3 from today's own weekday, which is guaranteed to differ
    // from BOTH outsideWindowDate's weekday (offset 0, same as today) AND
    // unclaimedDate's weekday (offset -3 ≡ +4 mod 7) — so this filler pattern never
    // itself creates anything inside this window.
    const fillerDow = (mondayBasedDow(today) + 3) % 7;
    await app.prisma.employeeVocationalSchoolPattern.create({
      data: {
        employeeId: data.employee.id,
        dayOfWeek: fillerDow,
        daysOfWeek: [fillerDow],
        blockWeeks: [],
        validFrom: today,
        isActive: true,
      },
    });

    const result = await runVocationalSchoolGeneration(app.prisma, app.audit, {
      tenantId: data.tenant.id,
      employeeId: data.employee.id,
      windowStart,
      windowEnd: today,
      overrideDates: [toIso(outsideWindowDate), toIso(unclaimedDate)],
    });
    expect(result.created).toBe(0);

    const absences = await app.prisma.absence.findMany({
      where: { employeeId: data.employee.id, type: "VOCATIONAL_SCHOOL" },
    });
    expect(absences).toHaveLength(0);
  });

  it("Test 26 — D-01 parity: preview and apply report the same skipped.timeEntryConflict for the same state and the same overrideDates", async () => {
    const conflictDate = daysAgoUtc(6);
    const overriddenDate = daysAgoUtc(5);
    const windowStart = daysAgoUtc(10);
    const today = todayUtc();

    for (const d of [conflictDate, overriddenDate]) {
      await createSingleDayPattern(d);
      await createConflictingTimeEntry(d);
    }

    const opts = {
      tenantId: data.tenant.id,
      employeeId: data.employee.id,
      windowStart,
      windowEnd: today,
      overrideDates: [toIso(overriddenDate)],
    };

    const preview = await previewVocationalSchoolGeneration(app.prisma, opts);
    const apply = await runVocationalSchoolGeneration(app.prisma, app.audit, opts);

    expect(preview.skipped.timeEntryConflict).toBe(1);
    expect(apply.skipped.timeEntryConflict).toBe(1);
    expect(preview.created).toBe(apply.created);
    expect(apply.created).toBe(1); // only the overridden date gets created
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

  // ── Task 2 — GET retroactive-preview / POST retroactive-apply routes ───────

  // ── Test 9 — T-103-AUTHZ ────────────────────────────────────────────────────

  it("Test 9 — T-103-AUTHZ: EMPLOYEE role gets 403 from both new routes", async () => {
    const previewRes = await app.inject({
      method: "GET",
      url: `${BASE}/retroactive-preview?employeeId=${data.employee.id}`,
      headers: { authorization: `Bearer ${data.empToken}` },
    });
    expect(previewRes.statusCode).toBe(403);

    const applyRes = await app.inject({
      method: "POST",
      url: `${BASE}/retroactive-apply`,
      headers: { authorization: `Bearer ${data.empToken}` },
      payload: { employeeId: data.employee.id },
    });
    expect(applyRes.statusCode).toBe(403);
  });

  // ── Test 10 — T-103-IDOR ────────────────────────────────────────────────────

  it("Test 10 — T-103-IDOR: an ADMIN of tenant A passing an employeeId from tenant B gets 404, never 403 or a partial result", async () => {
    const previewRes = await app.inject({
      method: "GET",
      url: `${BASE}/retroactive-preview?employeeId=${otherTenantData.employee.id}`,
      headers: { authorization: `Bearer ${data.adminToken}` },
    });
    expect(previewRes.statusCode).toBe(404);
    expect(JSON.parse(previewRes.body)).toEqual({ error: "Mitarbeiter nicht gefunden" });

    const applyRes = await app.inject({
      method: "POST",
      url: `${BASE}/retroactive-apply`,
      headers: { authorization: `Bearer ${data.adminToken}` },
      payload: { employeeId: otherTenantData.employee.id },
    });
    expect(applyRes.statusCode).toBe(404);
    expect(JSON.parse(applyRes.body)).toEqual({ error: "Mitarbeiter nicht gefunden" });
  });

  // ── Test 11 — T-103-WINDOW ──────────────────────────────────────────────────

  it("Test 11 — T-103-WINDOW: extra windowStart/windowEnd/weeks query keys do not change the computed window", async () => {
    const past = daysAgoUtc(6 * 7);
    await app.prisma.employeeVocationalSchoolPattern.create({
      data: {
        employeeId: data.employee.id,
        dayOfWeek: 1,
        daysOfWeek: [1],
        blockWeeks: [],
        validFrom: past,
        isActive: true,
      },
    });

    // Nonsense bounds, computed (not hardcoded) — their only job is to prove the
    // server ignores them entirely, not to represent a plausible window.
    const bogusWindowStart = toIso(daysAgoUtc(3650));
    const bogusWindowEnd = toIso(daysAgoUtc(3649));

    const withoutExtra = await app.inject({
      method: "GET",
      url: `${BASE}/retroactive-preview?employeeId=${data.employee.id}`,
      headers: { authorization: `Bearer ${data.adminToken}` },
    });
    const withExtra = await app.inject({
      method: "GET",
      url:
        `${BASE}/retroactive-preview?employeeId=${data.employee.id}` +
        `&windowStart=${bogusWindowStart}&windowEnd=${bogusWindowEnd}&weeks=1`,
      headers: { authorization: `Bearer ${data.adminToken}` },
    });

    expect(withoutExtra.statusCode).toBe(200);
    expect(withExtra.statusCode).toBe(200);
    const bodyWithout = JSON.parse(withoutExtra.body);
    const bodyWith = JSON.parse(withExtra.body);

    expect(bodyWith.windowStart).toBe(bodyWithout.windowStart);
    expect(bodyWith.windowEnd).toBe(bodyWithout.windowEnd);
    expect(bodyWith.created).toBe(bodyWithout.created);
    const extractCreatedDates = (body: { details: Array<{ action: string; date: string }> }) =>
      body.details
        .filter((entry) => entry.action === "created")
        .map((entry) => entry.date)
        .sort();
    expect(extractCreatedDates(bodyWith)).toEqual(extractCreatedDates(bodyWithout));
  });

  // ── Test 12 — future-only patterns ──────────────────────────────────────────

  it("Test 12 — an employee with only future-dated active patterns gets created: 0 and empty details[] from preview, and apply writes nothing", async () => {
    const future = new Date(todayUtc().getTime() + 14 * 86_400_000);
    await app.prisma.employeeVocationalSchoolPattern.create({
      data: {
        employeeId: data.employee.id,
        dayOfWeek: 1,
        daysOfWeek: [1],
        blockWeeks: [],
        validFrom: future,
        isActive: true,
      },
    });

    const previewRes = await app.inject({
      method: "GET",
      url: `${BASE}/retroactive-preview?employeeId=${data.employee.id}`,
      headers: { authorization: `Bearer ${data.adminToken}` },
    });
    expect(previewRes.statusCode).toBe(200);
    const previewBody = JSON.parse(previewRes.body);
    expect(previewBody.created).toBe(0);
    expect(previewBody.details).toEqual([]);

    const applyRes = await app.inject({
      method: "POST",
      url: `${BASE}/retroactive-apply`,
      headers: { authorization: `Bearer ${data.adminToken}` },
      payload: { employeeId: data.employee.id },
    });
    expect(applyRes.statusCode).toBe(200);

    const absenceCount = await app.prisma.absence.count({
      where: { employeeId: data.employee.id },
    });
    expect(absenceCount).toBe(0);
  });

  // ── Test 13 — D-01 end to end ───────────────────────────────────────────────

  it("Test 13 — D-01 end to end: preview reports N>0 and writes nothing; apply creates exactly N Absences with N triggerSource=RETROACTIVE AuditLog rows", async () => {
    const past = daysAgoUtc(6 * 7);
    await app.prisma.employeeVocationalSchoolPattern.create({
      data: {
        employeeId: data.employee.id,
        dayOfWeek: 3,
        daysOfWeek: [3],
        blockWeeks: [],
        validFrom: past,
        isActive: true,
      },
    });

    const previewRes = await app.inject({
      method: "GET",
      url: `${BASE}/retroactive-preview?employeeId=${data.employee.id}`,
      headers: { authorization: `Bearer ${data.adminToken}` },
    });
    const previewBody = JSON.parse(previewRes.body);
    expect(previewBody.created).toBeGreaterThan(0);
    const n = previewBody.created;

    const absenceCountBeforeApply = await app.prisma.absence.count({
      where: { employeeId: data.employee.id },
    });
    expect(absenceCountBeforeApply).toBe(0); // preview really did write nothing

    const applyRes = await app.inject({
      method: "POST",
      url: `${BASE}/retroactive-apply`,
      headers: { authorization: `Bearer ${data.adminToken}` },
      payload: { employeeId: data.employee.id },
    });
    expect(applyRes.statusCode).toBe(200);
    const applyBody = JSON.parse(applyRes.body);
    expect(applyBody.created).toBe(n);

    const absences = await app.prisma.absence.findMany({
      where: { employeeId: data.employee.id, type: "VOCATIONAL_SCHOOL", deletedAt: null },
    });
    expect(absences).toHaveLength(n);

    const auditRows = await app.prisma.auditLog.findMany({
      where: {
        entity: "Absence",
        action: "VOCATIONAL_SCHOOL_AUTO_GENERATED",
        entityId: { in: absences.map((a) => a.id) },
      },
    });
    expect(auditRows).toHaveLength(n);
    for (const row of auditRows) {
      const nv = row.newValue as { triggerSource?: string } | null;
      expect(nv?.triggerSource).toBe("RETROACTIVE");
    }
  });

  // ── Test 14 — T-103-REPLAY ──────────────────────────────────────────────────

  it("Test 14 — T-103-REPLAY: calling apply twice leaves the same Absence count; the second call reports created: 0 and skipped.existing > 0", async () => {
    const past = daysAgoUtc(5 * 7);
    await app.prisma.employeeVocationalSchoolPattern.create({
      data: {
        employeeId: data.employee.id,
        dayOfWeek: 4,
        daysOfWeek: [4],
        blockWeeks: [],
        validFrom: past,
        isActive: true,
      },
    });

    const firstRes = await app.inject({
      method: "POST",
      url: `${BASE}/retroactive-apply`,
      headers: { authorization: `Bearer ${data.adminToken}` },
      payload: { employeeId: data.employee.id },
    });
    const firstBody = JSON.parse(firstRes.body);
    expect(firstBody.created).toBeGreaterThan(0);
    const countAfterFirst = await app.prisma.absence.count({
      where: { employeeId: data.employee.id, deletedAt: null },
    });

    const secondRes = await app.inject({
      method: "POST",
      url: `${BASE}/retroactive-apply`,
      headers: { authorization: `Bearer ${data.adminToken}` },
      payload: { employeeId: data.employee.id },
    });
    const secondBody = JSON.parse(secondRes.body);
    expect(secondBody.created).toBe(0);
    expect(secondBody.skipped.existing).toBeGreaterThan(0);

    const countAfterSecond = await app.prisma.absence.count({
      where: { employeeId: data.employee.id, deletedAt: null },
    });
    expect(countAfterSecond).toBe(countAfterFirst);
  });

  // ── Test 15 — malformed input ───────────────────────────────────────────────

  it("Test 15 — malformed employeeId (non-UUID) is rejected by Zod with 400 before any DB lookup", async () => {
    const previewRes = await app.inject({
      method: "GET",
      url: `${BASE}/retroactive-preview?employeeId=not-a-uuid`,
      headers: { authorization: `Bearer ${data.adminToken}` },
    });
    expect(previewRes.statusCode).toBe(400);

    const applyRes = await app.inject({
      method: "POST",
      url: `${BASE}/retroactive-apply`,
      headers: { authorization: `Bearer ${data.adminToken}` },
      payload: { employeeId: "not-a-uuid" },
    });
    expect(applyRes.statusCode).toBe(400);
  });
});

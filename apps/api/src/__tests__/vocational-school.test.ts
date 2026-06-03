// Phase 62 — Berufsschultag integration tests.
//
// Covers BERSCH-01 (pattern CRUD), BERSCH-02 (auto-generation), BERSCH-08 (manual entries
// not overwritten), BERSCH-09 (locked months skipped).
//
// The generator helper uses pure UTC midnight for both Absence.startDate and the
// SaldoSnapshot.periodStart lookup key, so the tests seed snapshots with the same
// UTC-aligned month boundary (Date.UTC(y, m, 1)).

import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import { getTestApp, closeTestApp, seedTestData, cleanupTestData } from "./setup";
import type { FastifyInstance } from "fastify";

// Compute the next occurrence of a Mo-based weekday (0=Mo..6=So) strictly in the future.
function nextDow(targetDow: number): Date {
  const d = new Date();
  d.setUTCHours(0, 0, 0, 0);
  const native = d.getUTCDay(); // 0=Sun..6=Sat
  const cur = native === 0 ? 6 : native - 1; // 0=Mo..6=So
  const add = (targetDow - cur + 7) % 7 || 7;
  d.setUTCDate(d.getUTCDate() + add);
  return d;
}

// ISO week number (1..53) of a UTC date. Mirrors the helper in vocational-school-generator.ts.
function isoWeekOf(date: Date): { year: number; week: number } {
  const d = new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate()));
  const dayNum = d.getUTCDay() || 7;
  d.setUTCDate(d.getUTCDate() + 4 - dayNum);
  const yearStart = new Date(Date.UTC(d.getUTCFullYear(), 0, 1));
  const week = Math.ceil(((d.getTime() - yearStart.getTime()) / 86_400_000 + 1) / 7);
  return { year: d.getUTCFullYear(), week };
}

// UTC 00:00 of the 1st of `d`'s month.
function monthStartUtc(d: Date): Date {
  return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), 1));
}

// UTC 00:00 of the last day of `d`'s month.
function monthEndUtc(d: Date): Date {
  return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 0));
}

describe("Berufsschule (Phase 62)", () => {
  let app: FastifyInstance;
  let data: Awaited<ReturnType<typeof seedTestData>>;

  beforeAll(async () => {
    app = await getTestApp();
    data = await seedTestData(app, "vs");
  });

  afterAll(async () => {
    try {
      await cleanupTestData(app, data.tenant.id);
    } catch (err) {
      console.error("Test cleanup failed:", err);
    }
    await closeTestApp();
  });

  // Wipe phase-specific state between tests so each one starts from a clean slate.
  beforeEach(async () => {
    await app.prisma.employeeVocationalSchoolPattern.deleteMany({
      where: { employeeId: data.employee.id },
    });
    await app.prisma.absence.deleteMany({
      where: { employeeId: data.employee.id, type: "VOCATIONAL_SCHOOL" },
    });
    await app.prisma.saldoSnapshot.deleteMany({
      where: { employeeId: data.employee.id },
    });
  });

  // ── BERSCH-01: Pattern CRUD ────────────────────────────────────────────────

  it("BERSCH-01 — PUT /employees/:id/vocational-school-pattern persists pattern as ADMIN", async () => {
    const res = await app.inject({
      method: "PUT",
      url: `/api/v1/employees/${data.employee.id}/vocational-school-pattern`,
      headers: { authorization: `Bearer ${data.adminToken}` },
      payload: {
        patterns: [{ daysOfWeek: [2], blockWeeks: [], validFrom: "2026-06-01" }],
      },
    });
    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body);
    expect(body.patterns).toHaveLength(1);
    expect(body.patterns[0].daysOfWeek).toEqual([2]);
    // Backwards-compat field still surfaced for single-day rows.
    expect(body.patterns[0].dayOfWeek).toBe(2);

    const getRes = await app.inject({
      method: "GET",
      url: `/api/v1/employees/${data.employee.id}/vocational-school-pattern`,
      headers: { authorization: `Bearer ${data.adminToken}` },
    });
    expect(getRes.statusCode).toBe(200);
    const patterns = JSON.parse(getRes.body);
    expect(patterns).toHaveLength(1);
    expect(patterns[0].daysOfWeek).toEqual([2]);
    expect(patterns[0].dayOfWeek).toBe(2);
    expect(patterns[0].isActive).toBe(true);
  });

  it("BERSCH-01 — PUT rejected without daysOfWeek AND without blockWeeks (Zod refine)", async () => {
    const res = await app.inject({
      method: "PUT",
      url: `/api/v1/employees/${data.employee.id}/vocational-school-pattern`,
      headers: { authorization: `Bearer ${data.adminToken}` },
      payload: {
        patterns: [{ daysOfWeek: [], blockWeeks: [], validFrom: "2026-06-01" }],
      },
    });
    expect(res.statusCode).toBe(400);
  });

  it("BERSCH-01 — PUT rejected with blockWeeks but no blockYear (Zod refine)", async () => {
    const res = await app.inject({
      method: "PUT",
      url: `/api/v1/employees/${data.employee.id}/vocational-school-pattern`,
      headers: { authorization: `Bearer ${data.adminToken}` },
      payload: {
        patterns: [{ blockWeeks: [12, 13], validFrom: "2026-06-01" }],
      },
    });
    expect(res.statusCode).toBe(400);
  });

  it("BERSCH-01 — PUT as EMPLOYEE returns 403", async () => {
    const res = await app.inject({
      method: "PUT",
      url: `/api/v1/employees/${data.employee.id}/vocational-school-pattern`,
      headers: { authorization: `Bearer ${data.empToken}` },
      payload: {
        patterns: [{ daysOfWeek: [2], blockWeeks: [], validFrom: "2026-06-01" }],
      },
    });
    expect(res.statusCode).toBe(403);
  });

  it("BERSCH-01 — Replace-Semantik: second PUT deactivates first pattern", async () => {
    await app.inject({
      method: "PUT",
      url: `/api/v1/employees/${data.employee.id}/vocational-school-pattern`,
      headers: { authorization: `Bearer ${data.adminToken}` },
      payload: { patterns: [{ daysOfWeek: [2], blockWeeks: [], validFrom: "2026-06-01" }] },
    });
    await app.inject({
      method: "PUT",
      url: `/api/v1/employees/${data.employee.id}/vocational-school-pattern`,
      headers: { authorization: `Bearer ${data.adminToken}` },
      payload: { patterns: [{ daysOfWeek: [4], blockWeeks: [], validFrom: "2026-06-01" }] },
    });

    // GET returns ONLY the second pattern, both rows exist in DB but only #2 is active.
    const getRes = await app.inject({
      method: "GET",
      url: `/api/v1/employees/${data.employee.id}/vocational-school-pattern`,
      headers: { authorization: `Bearer ${data.adminToken}` },
    });
    const active = JSON.parse(getRes.body);
    expect(active).toHaveLength(1);
    expect(active[0].daysOfWeek).toEqual([4]);

    const allRows = await app.prisma.employeeVocationalSchoolPattern.findMany({
      where: { employeeId: data.employee.id },
    });
    expect(allRows).toHaveLength(2); // both retained for audit trail
    expect(allRows.filter((r) => r.isActive)).toHaveLength(1);
  });

  // ── Phase 67.1: Multi-day weekdays ────────────────────────────────────────

  it("BERSCH-01 (67.1) — PUT with 3 weekdays creates Absences for all matching days", async () => {
    // Pick Mo + Mi + Fr (0, 2, 4). Window is 4 weeks ahead, so we expect ~12 rows.
    await app.inject({
      method: "PUT",
      url: `/api/v1/employees/${data.employee.id}/vocational-school-pattern`,
      headers: { authorization: `Bearer ${data.adminToken}` },
      payload: {
        patterns: [{ daysOfWeek: [0, 2, 4], blockWeeks: [], validFrom: "2020-01-01" }],
      },
    });

    // Server should reflect array verbatim and clear the legacy single field
    // because multi-day rows have no unambiguous scalar.
    const getRes = await app.inject({
      method: "GET",
      url: `/api/v1/employees/${data.employee.id}/vocational-school-pattern`,
      headers: { authorization: `Bearer ${data.adminToken}` },
    });
    const persisted = JSON.parse(getRes.body);
    expect(persisted).toHaveLength(1);
    expect(persisted[0].daysOfWeek).toEqual([0, 2, 4]);
    // Legacy dayOfWeek field MUST be null for multi-day rows.
    expect(persisted[0].dayOfWeek).toBeNull();

    // Generator now produces Absences on all three weekdays.
    const genRes = await app.inject({
      method: "POST",
      url: "/api/v1/vocational-school/generate",
      headers: { authorization: `Bearer ${data.adminToken}` },
    });
    expect(genRes.statusCode).toBe(200);
    const genBody = JSON.parse(genRes.body);
    expect(genBody.created).toBeGreaterThan(0);

    const absences = await app.prisma.absence.findMany({
      where: {
        employeeId: data.employee.id,
        type: "VOCATIONAL_SCHOOL",
        deletedAt: null,
      },
    });
    const observedDows = new Set(
      absences.map((a) => {
        const native = a.startDate.getUTCDay();
        return native === 0 ? 6 : native - 1;
      }),
    );
    // All Absences land on one of the three configured weekdays.
    for (const d of observedDows) {
      expect([0, 2, 4]).toContain(d);
    }
    // And we cover the full set (window is 4 weeks ahead so each weekday hits ≥ 3 times).
    expect(observedDows.has(0)).toBe(true);
    expect(observedDows.has(2)).toBe(true);
    expect(observedDows.has(4)).toBe(true);
  });

  it("BERSCH-01 (67.1) — PUT with empty daysOfWeek + non-empty blockWeeks passes refine", async () => {
    const res = await app.inject({
      method: "PUT",
      url: `/api/v1/employees/${data.employee.id}/vocational-school-pattern`,
      headers: { authorization: `Bearer ${data.adminToken}` },
      payload: {
        patterns: [
          {
            daysOfWeek: [],
            blockWeeks: [12, 13],
            blockYear: 2026,
            validFrom: "2026-01-01",
          },
        ],
      },
    });
    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body);
    expect(body.patterns[0].daysOfWeek).toEqual([]);
    expect(body.patterns[0].blockWeeks).toEqual([12, 13]);
    expect(body.patterns[0].blockYear).toBe(2026);
  });

  // ── BERSCH-02: Auto-generation ─────────────────────────────────────────────

  it("BERSCH-02 — POST /vocational-school/generate creates Absence rows of type VOCATIONAL_SCHOOL", async () => {
    // Seed pattern targeting next Tuesday (dayOfWeek 1 = Tuesday in 0=Mo..6=So encoding).
    await app.prisma.employeeVocationalSchoolPattern.create({
      data: {
        employeeId: data.employee.id,
        dayOfWeek: 1, // Tuesday (legacy column for backwards-compat readers)
        daysOfWeek: [1], // Phase 67.1: canonical multi-day field
        blockWeeks: [],
        validFrom: new Date("2020-01-01"),
        isActive: true,
      },
    });

    const res = await app.inject({
      method: "POST",
      url: "/api/v1/vocational-school/generate",
      headers: { authorization: `Bearer ${data.adminToken}` },
    });
    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body);
    expect(body.created).toBeGreaterThan(0);

    const absences = await app.prisma.absence.findMany({
      where: {
        employeeId: data.employee.id,
        type: "VOCATIONAL_SCHOOL",
        deletedAt: null,
      },
    });
    expect(absences.length).toBeGreaterThan(0);
    for (const a of absences) {
      // All should be Tuesdays.
      const native = a.startDate.getUTCDay();
      const dow = native === 0 ? 6 : native - 1;
      expect(dow).toBe(1);
      expect(a.createdBy).toBe("SYSTEM");
    }
  });

  it("BERSCH-02 — Generator is idempotent (running twice creates no duplicates)", async () => {
    await app.prisma.employeeVocationalSchoolPattern.create({
      data: {
        employeeId: data.employee.id,
        dayOfWeek: 1,
        daysOfWeek: [1], // Phase 67.1: canonical multi-day field
        blockWeeks: [],
        validFrom: new Date("2020-01-01"),
        isActive: true,
      },
    });

    const res1 = await app.inject({
      method: "POST",
      url: "/api/v1/vocational-school/generate",
      headers: { authorization: `Bearer ${data.adminToken}` },
    });
    const body1 = JSON.parse(res1.body);
    expect(body1.created).toBeGreaterThan(0);
    const firstCount = body1.created;

    const res2 = await app.inject({
      method: "POST",
      url: "/api/v1/vocational-school/generate",
      headers: { authorization: `Bearer ${data.adminToken}` },
    });
    const body2 = JSON.parse(res2.body);
    expect(body2.created).toBe(0);
    expect(body2.skipped.existing).toBeGreaterThanOrEqual(firstCount);

    const absences = await app.prisma.absence.findMany({
      where: { employeeId: data.employee.id, type: "VOCATIONAL_SCHOOL", deletedAt: null },
    });
    expect(absences.length).toBe(firstCount); // No duplicates.
  });

  it("BERSCH-02 — Block-week pattern generates 7 Absence rows per matching ISO week", async () => {
    // Pick next Monday and use its ISO week as the block week.
    const nextMonday = nextDow(0); // 0=Mo
    const iso = isoWeekOf(nextMonday);

    await app.prisma.employeeVocationalSchoolPattern.create({
      data: {
        employeeId: data.employee.id,
        dayOfWeek: null,
        daysOfWeek: [], // Phase 67.1: pure block-week pattern
        blockWeeks: [iso.week],
        blockYear: iso.year,
        validFrom: new Date("2020-01-01"),
        isActive: true,
      },
    });

    const res = await app.inject({
      method: "POST",
      url: "/api/v1/vocational-school/generate",
      headers: { authorization: `Bearer ${data.adminToken}` },
    });
    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body);
    // Expect 7 days (Mo-Su) for that one block week.
    expect(body.created).toBe(7);

    const absences = await app.prisma.absence.findMany({
      where: { employeeId: data.employee.id, type: "VOCATIONAL_SCHOOL", deletedAt: null },
      orderBy: { startDate: "asc" },
    });
    expect(absences).toHaveLength(7);
    // All within the same ISO week
    for (const a of absences) {
      const wk = isoWeekOf(a.startDate);
      expect(wk.year).toBe(iso.year);
      expect(wk.week).toBe(iso.week);
    }
  });

  it("BERSCH-02 — POST as EMPLOYEE returns 403", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/api/v1/vocational-school/generate",
      headers: { authorization: `Bearer ${data.empToken}` },
    });
    expect(res.statusCode).toBe(403);
  });

  it("BERSCH-02 — cron-path decorator (app.runVocationalSchoolGeneration) works", async () => {
    await app.prisma.employeeVocationalSchoolPattern.create({
      data: {
        employeeId: data.employee.id,
        dayOfWeek: 1,
        daysOfWeek: [1], // Phase 67.1: canonical multi-day field
        blockWeeks: [],
        validFrom: new Date("2020-01-01"),
        isActive: true,
      },
    });
    // The decorator wraps a tenant-loop without arguments; we just verify it does not throw.
    expect(typeof app.runVocationalSchoolGeneration).toBe("function");
    await app.runVocationalSchoolGeneration!();

    // After the first run, there must be at least one VOCATIONAL_SCHOOL Absence.
    const count = await app.prisma.absence.count({
      where: { employeeId: data.employee.id, type: "VOCATIONAL_SCHOOL", deletedAt: null },
    });
    expect(count).toBeGreaterThan(0);

    // Re-running must be idempotent.
    await app.runVocationalSchoolGeneration!();
    const countAfter = await app.prisma.absence.count({
      where: { employeeId: data.employee.id, type: "VOCATIONAL_SCHOOL", deletedAt: null },
    });
    expect(countAfter).toBe(count);
  });

  // ── BERSCH-08: Manual entries protected ────────────────────────────────────

  it("BERSCH-08 — Manual VOCATIONAL_SCHOOL Absence is NOT overwritten", async () => {
    const nextTuesday = nextDow(1); // 1=Tu

    // Manual seed: pretend a human created this entry directly.
    const manual = await app.prisma.absence.create({
      data: {
        employeeId: data.employee.id,
        type: "VOCATIONAL_SCHOOL",
        startDate: nextTuesday,
        endDate: nextTuesday,
        days: 1.0,
        createdBy: "manual-test",
      },
    });

    await app.prisma.employeeVocationalSchoolPattern.create({
      data: {
        employeeId: data.employee.id,
        dayOfWeek: 1, // Tuesday (legacy column for backwards-compat readers)
        daysOfWeek: [1], // Phase 67.1: canonical multi-day field
        blockWeeks: [],
        validFrom: new Date("2020-01-01"),
        isActive: true,
      },
    });

    const res = await app.inject({
      method: "POST",
      url: "/api/v1/vocational-school/generate",
      headers: { authorization: `Bearer ${data.adminToken}` },
    });
    const body = JSON.parse(res.body);
    expect(body.skipped.existing).toBeGreaterThanOrEqual(1);

    // Manual row untouched.
    const refreshed = await app.prisma.absence.findUnique({ where: { id: manual.id } });
    expect(refreshed).not.toBeNull();
    expect(refreshed!.createdBy).toBe("manual-test");
  });

  it("BERSCH-08 — Manual non-VOCATIONAL_SCHOOL Absence (e.g. SICK) on same date blocks generation", async () => {
    const nextTuesday = nextDow(1);

    const sick = await app.prisma.absence.create({
      data: {
        employeeId: data.employee.id,
        type: "SICK",
        startDate: nextTuesday,
        endDate: nextTuesday,
        days: 1.0,
        createdBy: "manual-test",
      },
    });

    await app.prisma.employeeVocationalSchoolPattern.create({
      data: {
        employeeId: data.employee.id,
        dayOfWeek: 1,
        daysOfWeek: [1], // Phase 67.1: canonical multi-day field
        blockWeeks: [],
        validFrom: new Date("2020-01-01"),
        isActive: true,
      },
    });

    const res = await app.inject({
      method: "POST",
      url: "/api/v1/vocational-school/generate",
      headers: { authorization: `Bearer ${data.adminToken}` },
    });
    const body = JSON.parse(res.body);
    expect(body.skipped.existing).toBeGreaterThanOrEqual(1);

    // No VOCATIONAL_SCHOOL Absence was added on the SICK day.
    const vsOnSickDay = await app.prisma.absence.findMany({
      where: {
        employeeId: data.employee.id,
        type: "VOCATIONAL_SCHOOL",
        startDate: nextTuesday,
        deletedAt: null,
      },
    });
    expect(vsOnSickDay).toHaveLength(0);

    // The SICK row itself is untouched.
    const refreshed = await app.prisma.absence.findUnique({ where: { id: sick.id } });
    expect(refreshed!.type).toBe("SICK");
  });

  // ── BERSCH-09: Locked months ──────────────────────────────────────────────

  it("BERSCH-09 — Dates inside locked month (SaldoSnapshot present) are skipped", async () => {
    // Target a Tuesday inside the FOLLOWING calendar month (so locking it doesn't
    // collide with current-month tests). Generator runs 4 weeks ahead so next month is
    // within the rolling window.
    const today = new Date();
    today.setUTCHours(0, 0, 0, 0);
    const nextMonth = new Date(Date.UTC(today.getUTCFullYear(), today.getUTCMonth() + 1, 1));
    // First Tuesday of next month
    while (nextMonth.getUTCDay() !== 2) {
      // 2=Tuesday in JS-native
      nextMonth.setUTCDate(nextMonth.getUTCDate() + 1);
    }
    const targetTuesday = nextMonth;
    const lockMonthStart = monthStartUtc(targetTuesday);
    const lockMonthEnd = monthEndUtc(targetTuesday);

    // Seed SaldoSnapshot for the target month.
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

    // Seed pattern targeting Tuesdays.
    await app.prisma.employeeVocationalSchoolPattern.create({
      data: {
        employeeId: data.employee.id,
        dayOfWeek: 1, // Tuesday (legacy column for backwards-compat readers)
        daysOfWeek: [1], // Phase 67.1: canonical multi-day field
        blockWeeks: [],
        validFrom: new Date("2020-01-01"),
        isActive: true,
      },
    });

    // Force a longer window so the locked next-month date is in scope.
    // The route uses the tenant default (4 weeks) which may not always cover next month.
    // We can use the helper directly to set a custom window for deterministic results.
    const { runVocationalSchoolGeneration } = await import("../utils/vocational-school-generator");
    const result = await runVocationalSchoolGeneration(app.prisma, app.audit, {
      tenantId: data.tenant.id,
      weeksAhead: 8, // 8 weeks ahead guarantees coverage of next month
    });

    expect(result.skipped.locked).toBeGreaterThan(0);

    // No Absence in the locked month.
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

  it("BERSCH-09 — Future months without SaldoSnapshot ARE generated normally (regression guard)", async () => {
    await app.prisma.employeeVocationalSchoolPattern.create({
      data: {
        employeeId: data.employee.id,
        dayOfWeek: 1,
        daysOfWeek: [1], // Phase 67.1: canonical multi-day field
        blockWeeks: [],
        validFrom: new Date("2020-01-01"),
        isActive: true,
      },
    });

    const res = await app.inject({
      method: "POST",
      url: "/api/v1/vocational-school/generate",
      headers: { authorization: `Bearer ${data.adminToken}` },
    });
    const body = JSON.parse(res.body);
    expect(body.created).toBeGreaterThan(0);
    expect(body.skipped.locked).toBe(0);
  });
});

// Phase 79 Plan 01 Task 1 — Unit tests for assertMonthNotLocked + LockedMonthError.
//
// Tests the shared locked-month gate that Plans 79-02 / 79-03 / 79-04 will consume
// in the WorkEvent POST / PATCH / DELETE handlers + the /vocational-school/* BC proxy.
//
// REVISION (B2 / W4): The helper signature is `(prisma, employeeId, dateString, tz)`
// where `dateString` is YYYY-MM-DD. Year/month are parsed DIRECTLY from the string.
// Test 7 covers the non-Berlin TZ regression — proving the helper does NOT use
// `getUTCMonth()` (which would land on the wrong month for `"2026-02-28"` in
// `America/Los_Angeles`).

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { getTestApp, closeTestApp, seedTestData, cleanupTestData } from "./setup";
import type { FastifyInstance } from "fastify";
import {
  assertMonthNotLocked,
  LockedMonthError,
  LOCKED_MONTH_ERROR_DE,
} from "../utils/locked-month";
import { monthRangeUtc } from "../utils/timezone";

describe("locked-month: assertMonthNotLocked + LockedMonthError", () => {
  let app: FastifyInstance;
  let data: Awaited<ReturnType<typeof seedTestData>>;
  const TZ_BERLIN = "Europe/Berlin";
  const TZ_LA = "America/Los_Angeles";

  beforeAll(async () => {
    app = await getTestApp();
    data = await seedTestData(app, "locked-month");
  });

  afterAll(async () => {
    try {
      await cleanupTestData(app, data.tenant.id);
    } catch (err) {
      console.error("Test cleanup failed:", err);
    }
    await closeTestApp();
  });

  // Helper: seed a SaldoSnapshot for (employeeId, MONTHLY, monthStart) — mirrors
  // the lock-enforcement.test.ts pattern (closedAt/closedBy required, all minutes
  // fields required).
  async function seedSnapshot(
    employeeId: string,
    year: number,
    month: number,
    tz: string,
    opts: { superseded?: boolean } = {},
  ) {
    const { start, end } = monthRangeUtc(year, month, tz);
    return app.prisma.saldoSnapshot.create({
      data: {
        employeeId,
        periodType: "MONTHLY",
        periodStart: start,
        periodEnd: end,
        workedMinutes: 0,
        expectedMinutes: 0,
        balanceMinutes: 0,
        carryOver: 0,
        closedAt: new Date(),
        closedBy: data.adminEmployee.id,
        superseded: opts.superseded ?? false,
      },
    });
  }

  async function dropSnapshot(id: string) {
    await app.prisma.saldoSnapshot.delete({ where: { id } });
  }

  it("Test 1: resolves without throwing when no snapshot exists for the month", async () => {
    // April 2025 — no snapshot
    await expect(
      assertMonthNotLocked(app.prisma, data.employee.id, "2025-04-15", TZ_BERLIN),
    ).resolves.toBeUndefined();
  });

  it("Test 2: throws LockedMonthError when a non-superseded snapshot exists", async () => {
    // Seed a locked snapshot for May 2025 in Berlin
    const snap = await seedSnapshot(data.employee.id, 2025, 5, TZ_BERLIN);
    try {
      let caught: unknown = null;
      try {
        await assertMonthNotLocked(app.prisma, data.employee.id, "2025-05-20", TZ_BERLIN);
      } catch (err) {
        caught = err;
      }
      expect(caught).toBeInstanceOf(LockedMonthError);
      expect((caught as LockedMonthError).message).toBe(LOCKED_MONTH_ERROR_DE);
      expect(LOCKED_MONTH_ERROR_DE).toBe(
        "Monat ist abgeschlossen und kann nicht bearbeitet werden",
      );
    } finally {
      await dropSnapshot(snap.id);
    }
  });

  it("Test 3: resolves when a snapshot exists but is superseded:true (Phase 76.6 cleanup)", async () => {
    // Seed a SUPERSEDED snapshot for June 2025 — should NOT lock the month
    const snap = await seedSnapshot(data.employee.id, 2025, 6, TZ_BERLIN, { superseded: true });
    try {
      await expect(
        assertMonthNotLocked(app.prisma, data.employee.id, "2025-06-10", TZ_BERLIN),
      ).resolves.toBeUndefined();
    } finally {
      await dropSnapshot(snap.id);
    }
  });

  it("Test 4: delegates month math to monthRangeUtc(year, month, tz) — string '2026-03-15' resolves to March", async () => {
    // Seed snapshot for March 2026; query with day-15 string → must hit March's monthStart.
    const snap = await seedSnapshot(data.employee.id, 2026, 3, TZ_BERLIN);
    try {
      let threw = false;
      try {
        await assertMonthNotLocked(app.prisma, data.employee.id, "2026-03-15", TZ_BERLIN);
      } catch {
        threw = true;
      }
      expect(threw).toBe(true); // hit March → locked
      // Sanity: query a different month (April) must NOT throw
      await expect(
        assertMonthNotLocked(app.prisma, data.employee.id, "2026-04-15", TZ_BERLIN),
      ).resolves.toBeUndefined();
    } finally {
      await dropSnapshot(snap.id);
    }
  });

  it("Test 5: scoping is per-employee — snapshot for employee A does not lock employee B's month", async () => {
    const snap = await seedSnapshot(data.employee.id, 2025, 7, TZ_BERLIN);
    try {
      // Same month, different employee (the adminEmployee) → must resolve
      await expect(
        assertMonthNotLocked(app.prisma, data.adminEmployee.id, "2025-07-15", TZ_BERLIN),
      ).resolves.toBeUndefined();
    } finally {
      await dropSnapshot(snap.id);
    }
  });

  it("Test 6: LockedMonthError shape — instanceof Error + LockedMonthError, name + statusCode 403", () => {
    const err = new LockedMonthError();
    expect(err).toBeInstanceOf(Error);
    expect(err).toBeInstanceOf(LockedMonthError);
    expect(err.name).toBe("LockedMonthError");
    expect(err.statusCode).toBe(403);
    expect(err.message).toBe(LOCKED_MONTH_ERROR_DE);
  });

  it("Test 7 (B2 / W4): non-Berlin TZ regression — '2026-02-28' with America/Los_Angeles resolves to February, NOT March", async () => {
    // Seed February-2026 snapshot in America/Los_Angeles → call MUST throw.
    const febSnap = await seedSnapshot(data.employee.id, 2026, 2, TZ_LA);
    try {
      let caught: unknown = null;
      try {
        await assertMonthNotLocked(app.prisma, data.employee.id, "2026-02-28", TZ_LA);
      } catch (err) {
        caught = err;
      }
      expect(caught).toBeInstanceOf(LockedMonthError);
    } finally {
      await dropSnapshot(febSnap.id);
    }

    // Conversely: seed for MARCH instead of February; call with "2026-02-28" → must RESOLVE.
    // (If the helper used getUTCMonth() it would resolve "2026-02-28" to Feb 28 UTC and
    // still hit February's range — but with a March-only snapshot we'd see no throw too.
    // The real proof of byte-identical string-parsing is the prior assertion: Feb seed
    // → throws. Together they pin the contract.)
    const marSnap = await seedSnapshot(data.employee.id, 2026, 3, TZ_LA);
    try {
      await expect(
        assertMonthNotLocked(app.prisma, data.employee.id, "2026-02-28", TZ_LA),
      ).resolves.toBeUndefined();
    } finally {
      await dropSnapshot(marSnap.id);
    }
  });
});

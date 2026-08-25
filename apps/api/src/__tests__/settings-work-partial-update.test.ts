/**
 * settings-work-partial-update.test.ts
 *
 * Phase 100 code review (WR-01) — PUT /api/v1/settings/work/:employeeId used to
 * full-replace `maxNegativeBalanceMinutes` on every write
 * (`body.maxNegativeBalanceMinutes ?? null`), so a caller that simply omits the key
 * — exactly what the only web UI writing this route currently does
 * (`admin/employees/[id]/+page.svelte`'s `buildSchedulePayload()` has no form
 * control for this field) — coerced "not sent" into "explicit null" and silently
 * wiped any previously-configured per-employee override back to null the next
 * time an admin saved an unrelated schedule change.
 *
 * Fixed to PARTIAL-UPDATE semantics on BOTH write sites in settings.ts: the key
 * is only included in the Prisma `data` object when
 * `body.maxNegativeBalanceMinutes !== undefined`, so Prisma skips it entirely
 * (leaving the stored value untouched) when the caller omits it, while an
 * explicit `null` in the payload still clears it — mirroring
 * `PUT /settings/security`'s pre-existing `update: body` pattern.
 *
 * Every date in this file is computed from `new Date()` — no hardcoded calendar
 * literal — matching the no-literal discipline of the sibling Phase 100 suite
 * (settings-work-tenant-isolation.test.ts).
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { getTestApp, seedTestData, cleanupTestData } from "./setup";
import type { FastifyInstance } from "fastify";

/** First of the month N months from now, UTC, as "YYYY-MM-01" (WorkSchedule.validFrom
 *  must be month-1st for every contract change — CLAUDE.md "Schedule Types"). */
function monthFirstUtcIso(monthsFromNow: number): string {
  const now = new Date();
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + monthsFromNow, 1))
    .toISOString()
    .slice(0, 10);
}

/** ISO date string N days from today (positive = future). */
function isoDateOffset(days: number): string {
  const d = new Date();
  d.setDate(d.getDate() + days);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

describe("PUT /api/v1/settings/work/:employeeId — maxNegativeBalanceMinutes partial-update semantics (Phase 100 WR-01 fix)", () => {
  let app: FastifyInstance;
  let data: Awaited<ReturnType<typeof seedTestData>>;
  const KNOWN_OVERRIDE = 180;

  beforeAll(async () => {
    app = await getTestApp();
    data = await seedTestData(app, "swpu");
  });

  afterAll(async () => {
    try {
      await cleanupTestData(app, data.tenant.id);
    } catch (err) {
      console.error("Cleanup failed:", err);
    }
  });

  it("normal update-in-place write site: a PUT that omits maxNegativeBalanceMinutes preserves an existing override", async () => {
    const validFrom = monthFirstUtcIso(3);

    // 1. Establish a KNOWN override on a fresh row at this validFrom.
    const setRes = await app.inject({
      method: "PUT",
      url: `/api/v1/settings/work/${data.employee.id}`,
      headers: { authorization: `Bearer ${data.adminToken}` },
      payload: {
        type: "FIXED_SCHEDULE",
        weeklyHours: 40,
        validFrom,
        maxNegativeBalanceMinutes: KNOWN_OVERRIDE,
      },
    });
    expect(setRes.statusCode).toBe(200);
    expect(JSON.parse(setRes.body).maxNegativeBalanceMinutes).toBe(KNOWN_OVERRIDE);

    // 2. A SECOND PUT to the SAME validFrom (update-in-place branch), changing an
    //    unrelated field and OMITTING maxNegativeBalanceMinutes entirely — mirrors
    //    admin/employees/[id]/+page.svelte, whose buildSchedulePayload() never sends
    //    this key today. This is the exact WR-01 regression scenario.
    const updateRes = await app.inject({
      method: "PUT",
      url: `/api/v1/settings/work/${data.employee.id}`,
      headers: { authorization: `Bearer ${data.adminToken}` },
      payload: {
        type: "FIXED_SCHEDULE",
        weeklyHours: 42, // the "unrelated change"
        validFrom,
        // maxNegativeBalanceMinutes intentionally omitted
      },
    });
    expect(updateRes.statusCode).toBe(200);
    const updated = JSON.parse(updateRes.body);
    expect(Number(updated.weeklyHours)).toBe(42);
    // The override must survive the unrelated edit — this is the WR-01 regression.
    expect(updated.maxNegativeBalanceMinutes).toBe(KNOWN_OVERRIDE);

    // 3. Confirm at the DB level too (belt-and-suspenders against a response-shaping bug).
    const stored = await app.prisma.workSchedule.findUniqueOrThrow({ where: { id: updated.id } });
    expect(stored.maxNegativeBalanceMinutes).toBe(KNOWN_OVERRIDE);
  });

  it("an explicit null in the payload still clears a previously-configured override", async () => {
    const validFrom = monthFirstUtcIso(4);

    const setRes = await app.inject({
      method: "PUT",
      url: `/api/v1/settings/work/${data.employee.id}`,
      headers: { authorization: `Bearer ${data.adminToken}` },
      payload: {
        type: "FIXED_SCHEDULE",
        weeklyHours: 40,
        validFrom,
        maxNegativeBalanceMinutes: KNOWN_OVERRIDE,
      },
    });
    expect(setRes.statusCode).toBe(200);
    expect(JSON.parse(setRes.body).maxNegativeBalanceMinutes).toBe(KNOWN_OVERRIDE);

    const clearRes = await app.inject({
      method: "PUT",
      url: `/api/v1/settings/work/${data.employee.id}`,
      headers: { authorization: `Bearer ${data.adminToken}` },
      payload: {
        type: "FIXED_SCHEDULE",
        weeklyHours: 40,
        validFrom,
        maxNegativeBalanceMinutes: null,
      },
    });
    expect(clearRes.statusCode).toBe(200);
    expect(JSON.parse(clearRes.body).maxNegativeBalanceMinutes).toBeNull();
  });
});

describe("PUT .../:employeeId cancelOrphanShifts write site — maxNegativeBalanceMinutes partial-update (Phase 100 WR-01 fix)", () => {
  let app: FastifyInstance;
  let data: Awaited<ReturnType<typeof seedTestData>>;
  let shiftEmployee: { id: string };
  const KNOWN_OVERRIDE = 210;

  // Row A: the "prior effective" SHIFT_BASED schedule (validFrom safely in the past —
  // 12 months back always satisfies validFrom <= now regardless of when this runs).
  const priorValidFrom = monthFirstUtcIso(-12);
  // Row B: an already-scheduled FUTURE type change (FLEXTIME) that already carries a
  // configured override — this is the row the cancelOrphanShifts $transaction's
  // "existingForDate" update-in-place path will target.
  const targetValidFrom = monthFirstUtcIso(6);

  beforeAll(async () => {
    app = await getTestApp();
    data = await seedTestData(app, "swpu-osh");

    const bcryptMod = await import("bcryptjs");
    const passwordHash = await bcryptMod.default.hash("test1234", 10);
    const user = await app.prisma.user.create({
      data: {
        email: `swpu-osh-emp-${Date.now()}@test.de`,
        passwordHash,
        role: "EMPLOYEE",
        isActive: true,
      },
    });
    shiftEmployee = await app.prisma.employee.create({
      data: {
        tenantId: data.tenant.id,
        userId: user.id,
        employeeNumber: `SWPU-OSH-${Date.now()}`,
        firstName: "Orphan",
        lastName: "PartialUpdate",
        hireDate: new Date(priorValidFrom),
      },
    });
    await app.prisma.overtimeAccount.create({
      data: { employeeId: shiftEmployee.id, balanceHours: 0 },
    });
    // Row A — prior effective schedule, SHIFT_BASED.
    await app.prisma.workSchedule.create({
      data: {
        employeeId: shiftEmployee.id,
        type: "SHIFT_BASED",
        weeklyHours: 40,
        validFrom: new Date(priorValidFrom),
      },
    });
    // Row B — pre-existing FUTURE FLEXTIME row with a KNOWN override already set.
    await app.prisma.workSchedule.create({
      data: {
        employeeId: shiftEmployee.id,
        type: "FLEXTIME",
        weeklyHours: 40,
        maxNegativeBalanceMinutes: KNOWN_OVERRIDE,
        validFrom: new Date(targetValidFrom),
      },
    });
    // A real future shift so the request actually routes through the
    // cancelOrphanShifts $transaction branch in settings.ts.
    await app.prisma.shift.create({
      data: {
        employeeId: shiftEmployee.id,
        date: new Date(isoDateOffset(3) + "T00:00:00Z"),
        startTime: "08:00",
        endTime: "16:00",
        createdBy: data.adminEmployee.id,
      },
    });
  });

  afterAll(async () => {
    try {
      await cleanupTestData(app, data.tenant.id);
    } catch (err) {
      console.error("Cleanup failed:", err);
    }
  });

  it("cancelOrphanShifts=true, existingForDate update-in-place: a PUT that omits maxNegativeBalanceMinutes preserves the prior override", async () => {
    const res = await app.inject({
      method: "PUT",
      url: `/api/v1/settings/work/${shiftEmployee.id}`,
      headers: { authorization: `Bearer ${data.adminToken}` },
      payload: {
        type: "FLEXTIME",
        weeklyHours: 40,
        validFrom: targetValidFrom,
        cancelOrphanShifts: true,
        // maxNegativeBalanceMinutes intentionally omitted
      },
    });

    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body);
    expect(body.type).toBe("FLEXTIME");
    // The override on Row B must survive — this is the WR-01 regression, on the
    // SECOND write site (the cancelOrphanShifts $transaction branch).
    expect(body.maxNegativeBalanceMinutes).toBe(KNOWN_OVERRIDE);

    // Future shift must still have been deleted (orphan-shift lifecycle unaffected).
    const remainingFuture = await app.prisma.shift.findMany({
      where: {
        employeeId: shiftEmployee.id,
        date: { gte: new Date(isoDateOffset(0) + "T00:00:00Z") },
      },
    });
    expect(remainingFuture).toHaveLength(0);
  });
});

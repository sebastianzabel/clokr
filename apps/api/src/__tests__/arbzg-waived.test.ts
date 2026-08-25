// Phase 91 Plan 03 — checkArbZG WAIVED compliance-flag suppression (BREAK-03).
//
// LOCKED (91-CONTEXT.md): when a TimeEntry's breakStatus is WAIVED ("durchgearbeitet"),
// the §4 ArbZG "break too short" finding must NOT be a blocking severity:"error" — it is
// downgraded and flagged waived:true (compliance-flag, not a hard block). CONFIRMED (and
// AUTO/default) days keep the existing severity:"error" behavior unchanged. §3/§5 findings
// are unaffected by WAIVED — only the §4 BREAK_TOO_SHORT branch is in scope.
//
// Legal basis: BAG 12.02.2025, 5 AZR 51/24.

import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import { getTestApp, closeTestApp, seedTestData, cleanupTestData } from "./setup";
import type { FastifyInstance } from "fastify";
import { checkArbZG } from "../utils/arbzg";

function utcDate(iso: string): Date {
  return new Date(`${iso}T00:00:00.000Z`);
}

async function seedTimeEntry(
  app: FastifyInstance,
  employeeId: string,
  date: Date,
  startTime: Date,
  endTime: Date,
  opts: { breakMinutes?: number; breakStatus?: "AUTO" | "CONFIRMED" | "WAIVED" } = {},
) {
  return app.prisma.timeEntry.create({
    data: {
      employeeId,
      date,
      startTime,
      endTime,
      breakMinutes: opts.breakMinutes ?? 0,
      breakStatus: opts.breakStatus ?? "CONFIRMED",
      source: "MANUAL",
      type: "WORK",
    },
  });
}

describe("checkArbZG WAIVED compliance-flag (Phase 91 Plan 03 — BREAK-03)", () => {
  let app: FastifyInstance;
  let data: Awaited<ReturnType<typeof seedTestData>>;

  // Anchor date far from other test fixtures' collision ranges.
  const MON = utcDate("2026-09-07");

  beforeAll(async () => {
    app = await getTestApp();
    data = await seedTestData(app, "arbzg-waived");
  });

  afterAll(async () => {
    try {
      await cleanupTestData(app, data.tenant.id);
    } catch (err) {
      console.error("Test cleanup failed:", err);
    }
    await closeTestApp();
  });

  beforeEach(async () => {
    await app.prisma.absence.deleteMany({ where: { employeeId: data.employee.id } });
    await app.prisma.timeEntry.deleteMany({ where: { employeeId: data.employee.id } });
  });

  it("WAIVED >9h day downgrades BREAK_TOO_SHORT: waived===true and severity !== 'error'", async () => {
    // ~10h net work, no break, breakStatus WAIVED ("durchgearbeitet").
    await seedTimeEntry(
      app,
      data.employee.id,
      MON,
      new Date("2026-09-07T06:00:00.000Z"),
      new Date("2026-09-07T16:00:00.000Z"),
      { breakMinutes: 0, breakStatus: "WAIVED" },
    );

    const warnings = await checkArbZG(app.prisma, data.employee.id, MON);
    const w = warnings.find((x) => x.code === "BREAK_TOO_SHORT");
    expect(w).toBeDefined();
    expect(w!.waived).toBe(true);
    expect(w!.severity).not.toBe("error");
  });

  it("CONFIRMED >9h day keeps BREAK_TOO_SHORT severity 'error' (regression guard)", async () => {
    // Same ~10h shape, but breakStatus explicitly CONFIRMED — unchanged behavior.
    await seedTimeEntry(
      app,
      data.employee.id,
      MON,
      new Date("2026-09-07T06:00:00.000Z"),
      new Date("2026-09-07T16:00:00.000Z"),
      { breakMinutes: 0, breakStatus: "CONFIRMED" },
    );

    const warnings = await checkArbZG(app.prisma, data.employee.id, MON);
    const w = warnings.find((x) => x.code === "BREAK_TOO_SHORT");
    expect(w).toBeDefined();
    expect(w!.severity).toBe("error");
    expect(w!.waived).toBeFalsy();
  });

  it("WAIVED day does NOT suppress a §3 MAX_DAILY_EXCEEDED finding (only §4 is affected)", async () => {
    // ~11h net work (exceeds the 10h absolute cap), WAIVED break status.
    await seedTimeEntry(
      app,
      data.employee.id,
      MON,
      new Date("2026-09-07T05:00:00.000Z"),
      new Date("2026-09-07T16:00:00.000Z"),
      { breakMinutes: 0, breakStatus: "WAIVED" },
    );

    const warnings = await checkArbZG(app.prisma, data.employee.id, MON);
    const daily = warnings.find((x) => x.code === "MAX_DAILY_EXCEEDED");
    expect(daily).toBeDefined();
    expect(daily!.severity).toBe("error");
  });

  it("WAIVED day does NOT suppress a §5 MIN_REST_VIOLATED finding (only §4 is affected)", async () => {
    const SUN = utcDate("2026-09-06");
    // Previous day's work ends late, current day's WAIVED work starts too soon after (< 11h rest).
    await seedTimeEntry(
      app,
      data.employee.id,
      SUN,
      new Date("2026-09-06T18:00:00.000Z"),
      new Date("2026-09-06T22:00:00.000Z"),
      { breakMinutes: 0, breakStatus: "CONFIRMED" },
    );
    await seedTimeEntry(
      app,
      data.employee.id,
      MON,
      new Date("2026-09-07T04:00:00.000Z"),
      new Date("2026-09-07T14:00:00.000Z"),
      { breakMinutes: 0, breakStatus: "WAIVED" },
    );

    const warnings = await checkArbZG(app.prisma, data.employee.id, MON);
    expect(warnings.find((x) => x.code === "MIN_REST_VIOLATED")).toBeDefined();
  });
});

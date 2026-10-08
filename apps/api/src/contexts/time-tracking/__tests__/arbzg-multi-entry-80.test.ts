// Issue #80 (80-AC2, 80-AC3, 80-AC4, 80-AC7; D-01, D-16, D-18) — checkArbZG over a day with several
// entries in several salons.
//
// A multi-entry day cannot exist in the database while the partial unique index
// `TimeEntry_employeeId_date_unique_not_deleted` holds, so the day lookup (`findEntriesOfDay`) is
// mocked and returns constructed rows. The employee, tenant config and Berufsschule reads stay
// real; the other days the function looks up (§ 5 neighbours) return no rows.

import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from "vitest";
import { randomUUID } from "node:crypto";
import type { FastifyInstance } from "fastify";
import type { TimeEntry } from "@clokr/db";
import {
  getTestApp,
  closeTestApp,
  seedTestData,
  cleanupTestData,
  createTestSalon,
} from "../../../__tests__/setup";

vi.mock("../day-entries", async (importOriginal) => {
  const original = await importOriginal<typeof import("../day-entries")>();
  return { ...original, findEntriesOfDay: vi.fn(original.findEntriesOfDay) };
});

import { findEntriesOfDay } from "../day-entries";
import { checkArbZG } from "../arbzg";

const DAY = "2026-03-10";
const DAY_DATE = new Date(`${DAY}T00:00:00.000Z`);
const mockedLookup = vi.mocked(findEntriesOfDay);

function at(hhmm: string): Date {
  return new Date(`${DAY}T${hhmm}:00.000Z`);
}

describe("checkArbZG on a multi-entry, multi-salon day (Issue #80)", () => {
  let app: FastifyInstance;
  let data: Awaited<ReturnType<typeof seedTestData>>;
  let salonA: string;
  let salonB: string;

  /** A fully populated TimeEntry row — every column, so a drifting schema fails loudly. */
  function row(
    salonId: string,
    start: string,
    end: string,
    opts: { breakMinutes?: number; breakStatus?: "AUTO" | "CONFIRMED" | "WAIVED" } = {},
  ): TimeEntry {
    return {
      id: randomUUID(),
      employeeId: data.employee.id,
      date: DAY_DATE,
      startTime: at(start),
      endTime: at(end),
      breakMinutes: opts.breakMinutes ?? 0,
      type: "WORK",
      source: "MANUAL",
      note: null,
      isLocked: false,
      lockedAt: null,
      isInvalid: false,
      invalidReason: null,
      invalidReasonCode: null,
      deletedAt: null,
      createdAt: new Date("2026-03-10T20:00:00.000Z"),
      updatedAt: new Date("2026-03-10T20:00:00.000Z"),
      createdBy: null,
      breakStatus: opts.breakStatus ?? "CONFIRMED",
      breakWaivedReason: null,
      retroRequestId: null,
      salonId,
    } as unknown as TimeEntry;
  }

  function serveDay(rows: TimeEntry[]) {
    const sorted = [...rows].sort((a, b) => a.startTime.getTime() - b.startTime.getTime());
    mockedLookup.mockImplementation(async (_db, params) =>
      params.date.getTime() === DAY_DATE.getTime() ? sorted : [],
    );
  }

  beforeAll(async () => {
    app = await getTestApp();
    data = await seedTestData(app, "arbzg-multi-80");
    salonA = data.salonId;
    salonB = (await createTestSalon(app.prisma, data.tenant.id, { name: "Zweiter Salon" })).id;
  });

  afterAll(async () => {
    try {
      await cleanupTestData(app, data.tenant.id);
    } catch (err) {
      console.error("Test cleanup failed:", err);
    }
    await closeTestApp();
  });

  beforeEach(() => {
    mockedLookup.mockReset();
    mockedLookup.mockResolvedValue([]);
  });

  it("fixture sanity: two distinct real salons", () => {
    expect(salonA).toBeTruthy();
    expect(salonB).toBeTruthy();
    expect(salonA).not.toBe(salonB);
  });

  it("80-AC2/AC7: 4 h in salon A + 4 h in salon B without a break is one BREAK_TOO_SHORT warning (D-01)", async () => {
    serveDay([row(salonA, "08:00", "12:00"), row(salonB, "12:30", "16:30")]);
    const warnings = await checkArbZG(app.prisma, data.employee.id, DAY_DATE);
    const short = warnings.filter((w) => w.code === "BREAK_TOO_SHORT");
    // anti-vacuity: the fixture must produce a violation, otherwise the assertions below prove nothing
    expect(short.length).toBeGreaterThan(0);
    expect(short).toHaveLength(1);
    expect(short[0].severity).toBe("warning");
    expect(short[0].message).toBe(
      "§ 4 ArbZG: Bei über 6 Stunden Arbeitszeit sind mindestens 30 Minuten Pause vorgeschrieben. Erfasst: 0 Min.",
    );
    expect(short[0].crossSalon).toBe(true);
    expect("waived" in short[0]).toBe(false);
  });

  it("D-01: the same two rows in ONE salon keep the 30-minute gap as a break (unchanged rule)", async () => {
    serveDay([row(salonA, "08:00", "12:00"), row(salonA, "12:30", "16:30")]);
    const warnings = await checkArbZG(app.prisma, data.employee.id, DAY_DATE);
    expect(warnings.some((w) => w.code === "BREAK_TOO_SHORT")).toBe(false);
  });

  it("80-AC3: 30 minutes of entry break in salon A clears the cross-salon day", async () => {
    serveDay([row(salonA, "08:00", "12:30", { breakMinutes: 30 }), row(salonB, "13:00", "17:00")]);
    const warnings = await checkArbZG(app.prisma, data.employee.id, DAY_DATE);
    expect(warnings.some((w) => w.code === "BREAK_TOO_SHORT")).toBe(false);
  });

  it("80-AC3: 30 minutes of entry break in salon B clears the cross-salon day", async () => {
    serveDay([row(salonA, "08:00", "12:00"), row(salonB, "12:30", "17:00", { breakMinutes: 30 })]);
    const warnings = await checkArbZG(app.prisma, data.employee.id, DAY_DATE);
    expect(warnings.some((w) => w.code === "BREAK_TOO_SHORT")).toBe(false);
  });

  it("80-AC4: more than 9 h net over both salons with 30 minutes of break is an error with the 45-minute template", async () => {
    serveDay([row(salonA, "07:00", "12:30", { breakMinutes: 30 }), row(salonB, "13:00", "17:30")]);
    const warnings = await checkArbZG(app.prisma, data.employee.id, DAY_DATE);
    const short = warnings.filter((w) => w.code === "BREAK_TOO_SHORT");
    expect(short).toHaveLength(1);
    expect(short[0].severity).toBe("error");
    expect(short[0].message).toBe(
      "§ 4 ArbZG: Bei über 9 Stunden Arbeitszeit sind mindestens 45 Minuten Pause vorgeschrieben. Erfasst: 30 Min.",
    );
    expect(short[0].crossSalon).toBe(true);
  });

  it("D-18: MAX_DAILY_EXCEEDED over the day sum of two salons carries crossSalon", async () => {
    serveDay([row(salonA, "06:00", "12:00"), row(salonB, "12:30", "17:30")]);
    const warnings = await checkArbZG(app.prisma, data.employee.id, DAY_DATE);
    const max = warnings.filter((w) => w.code === "MAX_DAILY_EXCEEDED");
    expect(max).toHaveLength(1);
    expect(max[0].severity).toBe("error");
    expect(max[0].crossSalon).toBe(true);
  });

  it("D-16: an entry-level WAIVED does not downgrade a cross-salon day", async () => {
    serveDay([
      row(salonA, "07:00", "12:30", { breakMinutes: 30, breakStatus: "WAIVED" }),
      row(salonB, "13:00", "17:30"),
    ]);
    const warnings = await checkArbZG(app.prisma, data.employee.id, DAY_DATE);
    const short = warnings.filter((w) => w.code === "BREAK_TOO_SHORT");
    expect(short).toHaveLength(1);
    expect(short[0].severity).toBe("error");
    expect("waived" in short[0]).toBe(false);
  });

  it("a single-entry day carries no crossSalon key", async () => {
    serveDay([row(salonA, "08:00", "16:00")]);
    const warnings = await checkArbZG(app.prisma, data.employee.id, DAY_DATE);
    const short = warnings.filter((w) => w.code === "BREAK_TOO_SHORT");
    expect(short).toHaveLength(1);
    expect("crossSalon" in short[0]).toBe(false);
  });
});

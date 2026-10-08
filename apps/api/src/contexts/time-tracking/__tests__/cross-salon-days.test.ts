// Issue #80 (D-09b, D-15, D-17, D-18) — the cross-salon month-close detector.
// DB-free: the pure funnel is exercised directly, the bulk detector through a wrapper db object
// whose reads are recorded, so "no candidate day issues no query" is observable.

import { describe, it, expect, vi } from "vitest";
import { crossSalonCandidateDays, findUnacknowledgedCrossSalonDays } from "../cross-salon-days";
import type { CrossSalonRow } from "../cross-salon-days";
import { evaluateDayBreaks } from "../day-break-rule";
import type { DayBreakStoreDb } from "../day-break-store";

const TZ = "Europe/Berlin";
const A = "salon-a";
const B = "salon-b";

let seq = 0;
function row(
  employeeId: string,
  day: string,
  salonId: string,
  start: string,
  end: string,
  opts: { isLocked?: boolean; breakMinutes?: number; endTime?: Date | null } = {},
): CrossSalonRow {
  seq += 1;
  return {
    id: `row-${String(seq).padStart(3, "0")}`,
    employeeId,
    date: new Date(`${day}T00:00:00.000Z`),
    startTime: new Date(`${day}T${start}:00.000Z`),
    endTime: opts.endTime === undefined ? new Date(`${day}T${end}:00.000Z`) : opts.endTime,
    breakMinutes: opts.breakMinutes ?? 0,
    breakStatus: "CONFIRMED",
    salonId,
    isLocked: opts.isLocked ?? false,
  };
}

/** Two salons, 4 h each with a 30 min travel gap: 8 h net, § 4 shortfall (30 min required). */
function violationDay(employeeId: string, day: string): CrossSalonRow[] {
  return [row(employeeId, day, A, "08:00", "12:00"), row(employeeId, day, B, "12:30", "16:30")];
}

type FakeDb = DayBreakStoreDb & { reads: { model: string; where: unknown }[] };

function fakeDb(data: { dayBreaks?: unknown[]; acks?: unknown[] } = {}): FakeDb {
  const reads: { model: string; where: unknown }[] = [];
  const db = {
    reads,
    dayBreak: {
      findMany: vi.fn(async (args: { where: unknown }) => {
        reads.push({ model: "dayBreak", where: args.where });
        return data.dayBreaks ?? [];
      }),
    },
    dayBreakAck: {
      findMany: vi.fn(async (args: { where: unknown }) => {
        reads.push({ model: "dayBreakAck", where: args.where });
        return data.acks ?? [];
      }),
    },
  };
  return db as unknown as FakeDb;
}

describe("crossSalonCandidateDays — the pure funnel", () => {
  it("lists a day whose entries lie in two salons", () => {
    expect(crossSalonCandidateDays(violationDay("e1", "2026-03-10"), TZ)).toEqual(
      new Map([["e1", ["2026-03-10"]]]),
    );
  });

  it("ignores a day in one salon only", () => {
    const rows = [
      row("e1", "2026-03-10", A, "08:00", "12:00"),
      row("e1", "2026-03-10", A, "13:00", "17:00"),
    ];
    expect(crossSalonCandidateDays(rows, TZ).size).toBe(0);
  });

  it("skips a day with a locked row (a closed month is un-actionable)", () => {
    const allLocked = [
      row("e1", "2026-03-10", A, "08:00", "12:00", { isLocked: true }),
      row("e1", "2026-03-10", B, "12:30", "16:30", { isLocked: true }),
    ];
    expect(crossSalonCandidateDays(allLocked, TZ).size).toBe(0);
    const oneLocked = [
      row("e1", "2026-03-10", A, "08:00", "12:00"),
      row("e1", "2026-03-10", B, "12:30", "16:30", { isLocked: true }),
    ];
    expect(crossSalonCandidateDays(oneLocked, TZ).size).toBe(0);
  });

  it("skips an open entry: a day with only one closed salon row is not a candidate", () => {
    const rows = [
      row("e1", "2026-03-10", A, "08:00", "12:00"),
      row("e1", "2026-03-10", B, "12:30", "16:30", { endTime: null }),
    ];
    expect(crossSalonCandidateDays(rows, TZ).size).toBe(0);
  });

  it("keeps two employees and their sorted day lists apart", () => {
    const rows = [
      ...violationDay("e2", "2026-03-12"),
      ...violationDay("e1", "2026-03-11"),
      ...violationDay("e1", "2026-03-04"),
      row("e2", "2026-03-13", A, "08:00", "12:00"),
    ];
    expect(crossSalonCandidateDays(rows, TZ)).toEqual(
      new Map([
        ["e1", ["2026-03-04", "2026-03-11"]],
        ["e2", ["2026-03-12"]],
      ]),
    );
  });

  it("keys the days of the DST changes by their calendar date", () => {
    const rows = [...violationDay("e1", "2026-03-29"), ...violationDay("e1", "2026-10-25")];
    expect(crossSalonCandidateDays(rows, TZ).get("e1")).toEqual(["2026-03-29", "2026-10-25"]);
  });
});

describe("findUnacknowledgedCrossSalonDays", () => {
  it("issues no query at all without a candidate day", async () => {
    const db = fakeDb();
    const rows = [row("e1", "2026-03-10", A, "08:00", "17:00")];

    const result = await findUnacknowledgedCrossSalonDays(db, { tenantId: "t1", rows, tz: TZ });

    expect(result.size).toBe(0);
    expect(db.reads).toEqual([]);
  });

  it("issues exactly one read per model for any number of candidate days and employees", async () => {
    const db = fakeDb();
    const rows = [
      ...violationDay("e1", "2026-03-10"),
      ...violationDay("e1", "2026-03-24"),
      ...violationDay("e2", "2026-03-17"),
    ];

    const result = await findUnacknowledgedCrossSalonDays(db, { tenantId: "t1", rows, tz: TZ });

    expect(db.reads.map((r) => r.model).sort()).toEqual(["dayBreak", "dayBreakAck"]);
    expect([...result.keys()].sort()).toEqual(["e1", "e2"]);
    expect(result.get("e1")!.map((d) => d.date)).toEqual(["2026-03-10", "2026-03-24"]);
    const day = result.get("e1")![0];
    expect(day.evaluation.crossSalon).toBe(true);
    expect(day.evaluation.breakShortfall).toBe(true);
    expect(day.rows).toHaveLength(2);
    expect(day.rows.every((r) => r.employeeId === "e1")).toBe(true);
  });

  it("binds the reads to the tenant and the candidate span", async () => {
    const db = fakeDb();
    await findUnacknowledgedCrossSalonDays(db, {
      tenantId: "t1",
      rows: [...violationDay("e1", "2026-03-10"), ...violationDay("e1", "2026-03-24")],
      tz: TZ,
    });
    const where = db.reads[0].where as {
      employee: { tenantId: string };
      deletedAt: null;
      date: { gte: Date; lte: Date };
    };
    expect(where.employee).toEqual({ tenantId: "t1" });
    expect(where.deletedAt).toBeNull();
    expect(where.date.gte.toISOString()).toBe("2026-03-10T00:00:00.000Z");
    expect(where.date.lte.toISOString()).toBe("2026-03-24T00:00:00.000Z");
  });

  it("drops a day cured by a recorded day break in the gap", async () => {
    const rows = violationDay("e1", "2026-03-10");
    const db = fakeDb({
      dayBreaks: [
        {
          employeeId: "e1",
          date: new Date("2026-03-10T00:00:00.000Z"),
          startTime: new Date("2026-03-10T12:00:00.000Z"),
          endTime: new Date("2026-03-10T12:30:00.000Z"),
        },
      ],
    });

    const result = await findUnacknowledgedCrossSalonDays(db, { tenantId: "t1", rows, tz: TZ });

    expect(result.size).toBe(0);
  });

  it("drops a day with a current acknowledgement and keeps it with a stale or malformed one (D-17)", async () => {
    const rows = violationDay("e1", "2026-03-10");
    const { snapshot } = evaluateDayBreaks({
      rows: rows.map((r) => ({
        id: r.id,
        startTime: r.startTime,
        endTime: r.endTime!,
        breakMinutes: r.breakMinutes,
        salonId: r.salonId,
      })),
      dayBreaks: [],
      acks: [],
    });
    const ack = (snap: unknown) => ({
      employeeId: "e1",
      date: new Date("2026-03-10T00:00:00.000Z"),
      snapshot: snap,
    });
    const opts = { tenantId: "t1", rows, tz: TZ };

    const current = await findUnacknowledgedCrossSalonDays(fakeDb({ acks: [ack(snapshot)] }), opts);
    const stale = await findUnacknowledgedCrossSalonDays(
      fakeDb({ acks: [ack({ ...snapshot, netWorkedMin: snapshot.netWorkedMin + 1 })] }),
      opts,
    );
    const malformed = await findUnacknowledgedCrossSalonDays(
      fakeDb({ acks: [ack("garbage")] }),
      opts,
    );

    expect(current.size).toBe(0);
    expect(stale.get("e1")!.map((d) => d.date)).toEqual(["2026-03-10"]);
    expect(malformed.get("e1")!.map((d) => d.date)).toEqual(["2026-03-10"]);
  });

  it("never lists a § 3-only day: break satisfied, 11 h net (D-18)", async () => {
    const rows = [
      row("e1", "2026-03-10", A, "06:00", "12:00", { breakMinutes: 45 }),
      row("e1", "2026-03-10", B, "12:30", "18:30"),
    ];

    const result = await findUnacknowledgedCrossSalonDays(fakeDb(), {
      tenantId: "t1",
      rows,
      tz: TZ,
    });

    expect(result.size).toBe(0);
  });

  it("does not list a day below the § 4 threshold: 6 h net needs no break", async () => {
    const rows = [
      row("e1", "2026-03-10", A, "08:00", "11:00"),
      row("e1", "2026-03-10", B, "11:30", "14:30"),
    ];

    const result = await findUnacknowledgedCrossSalonDays(fakeDb(), {
      tenantId: "t1",
      rows,
      tz: TZ,
    });

    expect(result.size).toBe(0);
  });
});

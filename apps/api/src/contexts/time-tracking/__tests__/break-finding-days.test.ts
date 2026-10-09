// Issue #511 (D-12, D-14, D-15) — the break-finding detector of the month close.
// DB-free: the pure funnel is exercised directly, the bulk functions through a wrapper db object
// whose reads are recorded, so "no candidate day issues no query" is observable.

import { describe, it, expect, vi } from "vitest";
import {
  breakFindingCandidateDays,
  evaluateBreakFindingDays,
  findUnacknowledgedBreakFindingDays,
} from "../break-finding-days";
import type { BreakFindingRow } from "../break-finding-days";
import { LOWEST_BREAK_DUTY_MIN } from "../break-regime";
import type { DayBreakStoreDb } from "../day-break-store";

const TZ = "Europe/Berlin";
const A = "salon-a";
const B = "salon-b";
const ADULT = () => false;

let seq = 0;
function row(
  employeeId: string,
  day: string,
  salonId: string,
  start: string,
  end: string,
  opts: {
    isLocked?: boolean;
    breakMinutes?: number;
    endTime?: Date | null;
    startTime?: Date;
    id?: string;
  } = {},
): BreakFindingRow {
  seq += 1;
  return {
    id: opts.id ?? `row-${String(seq).padStart(3, "0")}`,
    employeeId,
    date: new Date(`${day}T00:00:00.000Z`),
    startTime: opts.startTime ?? new Date(`${day}T${start}:00.000Z`),
    endTime: opts.endTime === undefined ? new Date(`${day}T${end}:00.000Z`) : opts.endTime,
    breakMinutes: opts.breakMinutes ?? 0,
    breakStatus: "CONFIRMED",
    salonId,
    isLocked: opts.isLocked ?? false,
  };
}

type FakeDb = DayBreakStoreDb & { reads: string[] };

function fakeDb(
  data: {
    breaks?: { timeEntryId: string; startTime: Date; endTime: Date }[];
    dayBreaks?: unknown[];
    acks?: unknown[];
  } = {},
): FakeDb {
  const reads: string[] = [];
  const db = {
    reads,
    break: {
      findMany: vi.fn(async () => {
        reads.push("break");
        return data.breaks ?? [];
      }),
    },
    dayBreak: {
      findMany: vi.fn(async () => {
        reads.push("dayBreak");
        return data.dayBreaks ?? [];
      }),
    },
    dayBreakAck: {
      findMany: vi.fn(async () => {
        reads.push("dayBreakAck");
        return data.acks ?? [];
      }),
    },
  };
  return db as unknown as FakeDb;
}

describe("breakFindingCandidateDays — the pure funnel", () => {
  it("lists a day whose entries lie in two salons, however short", () => {
    const rows = [
      row("e1", "2026-03-10", A, "08:00", "09:00"),
      row("e1", "2026-03-10", B, "09:30", "10:00"),
    ];
    expect(breakFindingCandidateDays(rows, TZ)).toEqual(new Map([["e1", ["2026-03-10"]]]));
  });

  it("keeps a one-salon day only when the span exceeds the lowest break-duty band, to the millisecond", () => {
    const exactly = row("e1", "2026-03-10", A, "08:00", "08:00", {
      startTime: new Date("2026-03-10T08:00:00.000Z"),
      endTime: new Date(Date.parse("2026-03-10T08:00:00.000Z") + LOWEST_BREAK_DUTY_MIN * 60_000),
    });
    expect(LOWEST_BREAK_DUTY_MIN, "the band the funnel keys on").toBe(270);
    expect(breakFindingCandidateDays([exactly], TZ).size, "span of exactly 270 min").toBe(0);

    const oneMs = row("e2", "2026-03-10", A, "08:00", "08:00", {
      startTime: new Date("2026-03-10T08:00:00.000Z"),
      endTime: new Date(
        Date.parse("2026-03-10T08:00:00.000Z") + LOWEST_BREAK_DUTY_MIN * 60_000 + 1,
      ),
    });
    expect(breakFindingCandidateDays([oneMs], TZ), "span of 270 min + 1 ms").toEqual(
      new Map([["e2", ["2026-03-10"]]]),
    );
  });

  it("measures the span of a one-salon day from the first start to the last end across entries", () => {
    const rows = [
      row("e1", "2026-03-10", A, "08:00", "09:00"),
      row("e1", "2026-03-10", A, "13:00", "14:00"),
    ];
    expect(breakFindingCandidateDays(rows, TZ).get("e1")).toEqual(["2026-03-10"]);
  });

  it("skips a day with a locked row (a closed month is never re-evaluated)", () => {
    const oneLocked = [
      row("e1", "2026-03-10", A, "08:00", "12:00"),
      row("e1", "2026-03-10", B, "12:30", "16:30", { isLocked: true }),
    ];
    expect(breakFindingCandidateDays(oneLocked, TZ).size).toBe(0);
    expect(
      breakFindingCandidateDays(
        [row("e1", "2026-03-10", A, "08:00", "17:00", { isLocked: true })],
        TZ,
      ).size,
    ).toBe(0);
  });

  it("drops an open entry: a lone closed short row is not a candidate", () => {
    const rows = [
      row("e1", "2026-03-10", A, "08:00", "09:00"),
      row("e1", "2026-03-10", B, "12:30", "16:30", { endTime: null }),
    ];
    expect(breakFindingCandidateDays(rows, TZ).size).toBe(0);
  });

  it("keeps two employees and their sorted day lists apart", () => {
    const rows = [
      row("e2", "2026-03-12", A, "08:00", "16:00"),
      row("e1", "2026-03-11", A, "08:00", "16:00"),
      row("e1", "2026-03-04", A, "08:00", "16:00"),
      row("e2", "2026-03-13", A, "08:00", "09:00"),
    ];
    expect(breakFindingCandidateDays(rows, TZ)).toEqual(
      new Map([
        ["e1", ["2026-03-04", "2026-03-11"]],
        ["e2", ["2026-03-12"]],
      ]),
    );
  });

  it("keys the days of the DST changes by their calendar date", () => {
    const rows = [
      row("e1", "2026-03-29", A, "06:00", "14:00"),
      row("e1", "2026-10-25", A, "06:00", "14:00"),
    ];
    expect(breakFindingCandidateDays(rows, TZ).get("e1")).toEqual(["2026-03-29", "2026-10-25"]);
  });
});

describe("evaluateBreakFindingDays / findUnacknowledgedBreakFindingDays", () => {
  it("issues no query at all without a candidate day", async () => {
    const db = fakeDb();
    const rows = [row("e1", "2026-03-10", A, "08:00", "09:00")];

    expect(
      await evaluateBreakFindingDays(db, { tenantId: "t1", rows, tz: TZ, isMinorAt: ADULT }),
    ).toEqual([]);
    const found = await findUnacknowledgedBreakFindingDays(db, {
      tenantId: "t1",
      rows,
      tz: TZ,
      isMinorAt: ADULT,
    });

    expect(found.size).toBe(0);
    expect(db.reads).toEqual([]);
  });

  it("lists a Satz-3 day of one entry as PLACEMENT and reads each model once", async () => {
    const day = row("e1", "2026-03-10", A, "08:00", "16:00", { breakMinutes: 30, id: "entry-1" });
    const db = fakeDb({
      breaks: [
        {
          timeEntryId: "entry-1",
          startTime: new Date("2026-03-10T14:30:00.000Z"),
          endTime: new Date("2026-03-10T15:00:00.000Z"),
        },
      ],
    });

    const found = await findUnacknowledgedBreakFindingDays(db, {
      tenantId: "t1",
      rows: [day],
      tz: TZ,
      isMinorAt: ADULT,
    });

    expect(found.get("e1")?.map((d) => [d.date, d.kind])).toEqual([["2026-03-10", "PLACEMENT"]]);
    expect(found.get("e1")![0].evaluation.placement.findings.map((f) => f.code)).toContain(
      "BREAK_TOO_LATE",
    );
    expect(db.reads.sort()).toEqual(["break", "dayBreak", "dayBreakAck"]);
  });

  it("never lists a hint-only day and reads no day break or acknowledgement for it (A5)", async () => {
    const hintOnly = row("e1", "2026-03-10", A, "08:00", "16:30", { breakMinutes: 30 });
    const db = fakeDb();

    const found = await findUnacknowledgedBreakFindingDays(db, {
      tenantId: "t1",
      rows: [hintOnly],
      tz: TZ,
      isMinorAt: ADULT,
    });

    expect(found.size).toBe(0);
    expect(db.reads).toEqual(["break"]);
  });

  it("marks a cross-salon Satz-1 shortfall as CROSS_SALON", async () => {
    const rows = [
      row("e1", "2026-03-10", A, "08:00", "12:00"),
      row("e1", "2026-03-10", B, "12:30", "16:30"),
    ];

    const found = await findUnacknowledgedBreakFindingDays(fakeDb(), {
      tenantId: "t1",
      rows,
      tz: TZ,
      isMinorAt: ADULT,
    });

    expect(found.get("e1")?.map((d) => [d.date, d.kind])).toEqual([["2026-03-10", "CROSS_SALON"]]);
  });

  it("returns locked days only on request (the dry run) and flags them", async () => {
    const locked = row("e1", "2026-03-10", A, "08:00", "16:00", { isLocked: true });
    const opts = { tenantId: "t1", rows: [locked], tz: TZ, isMinorAt: ADULT };

    expect(await evaluateBreakFindingDays(fakeDb(), opts)).toEqual([]);
    const withLocked = await evaluateBreakFindingDays(fakeDb(), { ...opts, includeLocked: true });
    expect(withLocked.map((d) => [d.employeeId, d.date, d.locked])).toEqual([
      ["e1", "2026-03-10", true],
    ]);
    expect(
      (await findUnacknowledgedBreakFindingDays(fakeDb(), opts)).size,
      "the listing never includes a locked day",
    ).toBe(0);
  });

  it("evaluates a 4:31 block as BREAK_TOO_LATE only for a minor (injected isMinorAt, D-05)", async () => {
    const day = row("e1", "2026-03-10", A, "08:00", "12:31");
    const birthDate = new Date("2010-05-01T00:00:00.000Z");
    const birthDates = new Map<string, Date | null>([["e1", birthDate]]);
    const isMinorAt = vi.fn(() => true);

    const asMinor = await evaluateBreakFindingDays(fakeDb(), {
      tenantId: "t1",
      rows: [day],
      tz: TZ,
      birthDates,
      isMinorAt,
    });
    const asAdult = await evaluateBreakFindingDays(fakeDb(), {
      tenantId: "t1",
      rows: [day],
      tz: TZ,
      birthDates,
      isMinorAt: ADULT,
    });

    expect(asMinor[0].evaluation.placement.findings.map((f) => f.code)).toContain("BREAK_TOO_LATE");
    expect(asAdult[0].evaluation.placement.findings.map((f) => f.code)).not.toContain(
      "BREAK_TOO_LATE",
    );
    expect(isMinorAt).toHaveBeenCalledWith(birthDate, day.date);
  });

  it("passes null to isMinorAt when no birth date is known for the employee", async () => {
    const isMinorAt = vi.fn(() => false);

    await evaluateBreakFindingDays(fakeDb(), {
      tenantId: "t1",
      rows: [row("e1", "2026-03-10", A, "08:00", "16:00")],
      tz: TZ,
      isMinorAt,
    });

    expect(isMinorAt).toHaveBeenCalledWith(null, expect.any(Date));
  });
});

// Issue #86 (AC-86-5) - the pure display model of salon assignments. Expectations are written out by
// hand; the module only formats what the API answered.
import { describe, expect, it } from "vitest";
import {
  assignmentRows,
  deploymentBody,
  endBody,
  formatCalendarDay,
  homeBody,
  type SalonAssignment,
  type SalonRef,
} from "$lib/employees/salon-assignments";

const SALONS: SalonRef[] = [
  { id: "s-nord", name: "Salon Nord", isActive: true },
  { id: "s-ost", name: "Salon Ost", isActive: false },
];

function a(over: Partial<SalonAssignment> & Pick<SalonAssignment, "id">): SalonAssignment {
  return {
    employeeId: "e1",
    salonId: "s-nord",
    kind: "DEPLOYMENT",
    validFrom: "2026-01-01",
    validUntil: null,
    weekdays: [],
    ...over,
  };
}

describe("formatCalendarDay", () => {
  it("turns YYYY-MM-DD into TT.MM.JJJJ without a time zone", () => {
    expect(formatCalendarDay("2026-03-05")).toBe("05.03.2026");
    expect(formatCalendarDay("2026-12-31T00:00:00.000Z")).toBe("31.12.2026");
  });
});

describe("assignmentRows (Issue #86, AC-86-5)", () => {
  const today = "2026-10-16";

  it("lists current rows first, then ended ones, each by validFrom descending", () => {
    const rows = assignmentRows(
      [
        a({ id: "ended-old", validFrom: "2025-01-01", validUntil: "2025-06-30" }),
        a({ id: "cur-old", kind: "HOME", validFrom: "2024-01-01" }),
        a({ id: "ended-new", validFrom: "2026-01-01", validUntil: "2026-02-28" }),
        a({ id: "cur-new", validFrom: "2026-09-01" }),
        a({ id: "cur-future-end", validFrom: "2026-05-01", validUntil: "2026-10-16" }),
      ],
      SALONS,
      today,
    );
    expect(rows.map((r) => r.id)).toEqual([
      "cur-new",
      "cur-future-end",
      "cur-old",
      "ended-new",
      "ended-old",
    ]);
    expect(rows.map((r) => r.ended)).toEqual([false, false, false, true, true]);
  });

  it("labels kind, salon name, period and weekdays in German", () => {
    const rows = assignmentRows(
      [
        a({ id: "h", kind: "HOME", validFrom: "2026-01-01" }),
        a({ id: "d", validFrom: "2026-05-04", weekdays: [5, 1, 3, 0] }),
        a({ id: "x", salonId: "s-ost", validFrom: "2025-02-03", validUntil: "2025-04-30" }),
        a({ id: "u", salonId: "missing", validFrom: "2025-01-01", validUntil: "2025-01-31" }),
      ],
      SALONS,
      today,
    );
    const byId = Object.fromEntries(rows.map((r) => [r.id, r]));
    expect(byId.h).toMatchObject({
      kindLabel: "Stammsalon",
      salonName: "Salon Nord",
      periodLabel: "seit 01.01.2026",
      weekdaysLabel: "",
    });
    expect(byId.d).toMatchObject({
      kindLabel: "Einsatzsalon",
      periodLabel: "seit 04.05.2026",
      weekdaysLabel: "Mo, Mi, Fr, So",
    });
    expect(byId.x).toMatchObject({
      salonName: "Salon Ost (inaktiv)",
      periodLabel: "03.02.2025 – 30.04.2025",
      weekdaysLabel: "alle Tage",
      ended: true,
    });
    expect(byId.u.salonName).toBe("Unbekannter Salon");
  });

  it("only an open or not yet ended Einsatzsalon can be ended", () => {
    const rows = assignmentRows(
      [
        a({ id: "home", kind: "HOME" }),
        a({ id: "open" }),
        a({ id: "today", validUntil: "2026-10-16" }),
        a({ id: "past", validUntil: "2026-10-15" }),
      ],
      SALONS,
      today,
    );
    const canEnd = Object.fromEntries(rows.map((r) => [r.id, r.canEnd]));
    expect(canEnd).toEqual({ home: false, open: true, today: true, past: false });
  });

  it("does not mutate its inputs and survives empty lists", () => {
    const input = [
      a({ id: "b", validFrom: "2026-01-01" }),
      a({ id: "a", validFrom: "2026-06-01" }),
    ];
    const copy = JSON.parse(JSON.stringify(input));
    assignmentRows(input, SALONS, today);
    expect(input).toEqual(copy);
    expect(assignmentRows([], [], today)).toEqual([]);
  });
});

describe("request body builders (Issue #86, AC-86-5)", () => {
  it("deploymentBody omits validUntil and weekdays when they are empty", () => {
    const body = deploymentBody({
      salonId: "s1",
      validFrom: "2026-11-01",
      validUntil: "",
      weekdays: [],
    });
    expect(body).toEqual({ salonId: "s1", validFrom: "2026-11-01" });
    expect(Object.keys(body)).toEqual(["salonId", "validFrom"]);
  });

  it("deploymentBody sends validUntil and the weekdays sorted ascending, input untouched", () => {
    const weekdays = [5, 0, 3, 1];
    const body = deploymentBody({
      salonId: "s1",
      validFrom: "2026-11-01",
      validUntil: "2026-12-31",
      weekdays,
    });
    expect(body).toEqual({
      salonId: "s1",
      validFrom: "2026-11-01",
      validUntil: "2026-12-31",
      weekdays: [0, 1, 3, 5],
    });
    expect(weekdays).toEqual([5, 0, 3, 1]);
  });

  it("homeBody sends exactly salonId and validFrom", () => {
    const body = homeBody({ salonId: "s2", validFrom: "2026-11-01", ...{ extra: 1 } } as {
      salonId: string;
      validFrom: string;
    });
    expect(Object.keys(body).sort()).toEqual(["salonId", "validFrom"]);
  });

  it("endBody sends exactly validUntil", () => {
    expect(endBody("2026-11-30")).toEqual({ validUntil: "2026-11-30" });
  });
});

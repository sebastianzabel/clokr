// Issue #840 review WR-01 (D-840-08) — the Mon-Sat Werktage default must really apply when no single
// salon with configured opening hours is in view. `closedDaysFor()` always answers a Set (empty for
// "no single salon"), and an empty closed-day set reads as seven Werktage; `werktageBasis()` is the
// one place that tells the two apart, and every host feeds its result to `workdaySet()` and to the
// timeline. The model tests pass `null` directly and could not see the hosts' mistake.
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it, vi } from "vitest";

vi.mock("$api/client", () => ({
  api: { get: vi.fn() },
  ApiError: class ApiError extends Error {
    constructor(
      public status: number,
      message = "err",
    ) {
      super(message);
    }
  },
}));
vi.mock("$lib/utils/logger", () => ({ clientLogger: { warn: vi.fn(), error: vi.fn() } }));

import { ALL_SALONS, type SalonContextState } from "$stores/salon-context";
import { closedDaysFor, type SalonOpeningHoursEntry } from "$lib/shifts/closed-days";
import {
  weekCells,
  werktageBasis,
  workdaySet,
  type TimelineBar,
  type TimelinePerson,
} from "../timeline-model";

function state(): SalonContextState {
  return {
    loaded: true,
    tenant: { id: "tenant-1", name: "Mandant" },
    salons: [
      { id: "salon-1", name: "Salon Eins" },
      { id: "salon-2", name: "Salon Zwei" },
    ],
    isMultiSalon: true,
    homeSalonId: null,
    selection: ALL_SALONS,
    packages: null,
    roles: [],
  };
}

const HOURS_SUNDAY_CLOSED = [0, 1, 2, 3, 4, 5, 6].map((day) => ({
  day,
  open: "09:00",
  close: "18:00",
  ...(day === 6 ? { closed: true } : {}),
}));

const SALON_WITH_HOURS: SalonOpeningHoursEntry = {
  salonId: "salon-1",
  name: "Salon Eins",
  openingHours: HOURS_SUNDAY_CLOSED,
};
const SALON_WITHOUT_HOURS: SalonOpeningHoursEntry = {
  salonId: "salon-2",
  name: "Salon Zwei",
  openingHours: null,
};

const vacationWeek: TimelineBar = {
  key: "b",
  start: "2026-11-02",
  end: "2026-11-06",
  style: "gesetzt",
  typeCode: "VACATION",
  label: "Urlaub",
  editable: false,
};
const person: TimelinePerson = { employeeId: "e1", name: "e1", isOwn: false, bars: [vacationWeek] };

function weekShare(salons: SalonOpeningHoursEntry[] | undefined): number {
  const basis = werktageBasis(closedDaysFor(salons, state()), salons);
  const cell = weekCells(person, 2026, workdaySet(basis), []).find(
    (c) => c.monday === "2026-11-02",
  );
  return cell?.share ?? NaN;
}

describe("werktageBasis (WR-01)", () => {
  it("is null (Monday to Saturday) with no salon in view: a Mon-Fri week reads 5/6, not 5/7", () => {
    expect(werktageBasis(closedDaysFor([], state()), [])).toBeNull();
    expect(weekShare([])).toBeCloseTo(5 / 6, 10);
    expect(weekShare(undefined)).toBeCloseTo(5 / 6, 10);
  });

  it("is null with several salons and no usable choice", () => {
    expect(weekShare([SALON_WITH_HOURS, SALON_WITHOUT_HOURS])).toBeCloseTo(5 / 6, 10);
  });

  it("is null for a single salon whose opening hours are not configured", () => {
    expect(weekShare([SALON_WITHOUT_HOURS])).toBeCloseTo(5 / 6, 10);
    expect(weekShare([{ ...SALON_WITHOUT_HOURS, openingHours: [] }])).toBeCloseTo(5 / 6, 10);
  });

  it("is the closed weekdays of the one salon with opening hours", () => {
    const basis = werktageBasis(closedDaysFor([SALON_WITH_HOURS], state()), [SALON_WITH_HOURS]);
    expect([...(basis ?? [])]).toEqual([6]);
    expect(weekShare([SALON_WITH_HOURS])).toBeCloseTo(5 / 6, 10);
  });

  it("a salon open every day has seven Werktage: 5/7", () => {
    const allOpen: SalonOpeningHoursEntry = {
      ...SALON_WITH_HOURS,
      openingHours: HOURS_SUNDAY_CLOSED.map(({ day, open, close }) => ({ day, open, close })),
    };
    expect(weekShare([allOpen])).toBeCloseTo(5 / 7, 10);
  });
});

describe("the hosts decide the Werktage basis through werktageBasis (WR-01)", () => {
  const root = resolve(__dirname, "../../../..");
  const hosts = [
    "src/routes/(app)/team/leave/+page.svelte",
    "src/routes/(app)/leave/+page.svelte",
    "src/lib/components/leave/LeavePlanningPanel.svelte",
  ];
  for (const host of hosts) {
    it(`${host} calls werktageBasis and never feeds closedDays.days to workdaySet`, () => {
      const source = readFileSync(resolve(root, host), "utf8");
      expect(source).toContain("werktageBasis(");
      expect(source).not.toMatch(/workdaySet\(\s*\w*[cC]losedDays\.days\s*\)/);
      expect(source).not.toMatch(/closedWeekdays=\{\s*\w*[cC]losedDays\.days\s*\}/);
    });
  }
});

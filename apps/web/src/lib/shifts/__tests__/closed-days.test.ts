// Issue #563 (D-03, D-15, AC-563-2) — which closed days the week view dims, decided once, outside the
// page (the page imports `$app/*` and cannot be mounted here). The salon context is presentation:
// this module only picks which salon's hours to show, it never filters shifts or employees.
import { describe, expect, it, vi } from "vitest";

// The store imports the api client, which pulls in the auth store and its localStorage bootstrap; a
// stand-in (as in team-view.test.ts) keeps this file free of that.
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
import {
  SALON_HOURS_CHOOSE_HINT,
  closedDaysFor,
  type SalonOpeningHoursEntry,
} from "../closed-days";

function hours(closedDays: number[]) {
  return [0, 1, 2, 3, 4, 5, 6].map((day) => ({
    day,
    open: "09:00",
    close: "18:00",
    ...(closedDays.includes(day) ? { closed: true } : {}),
  }));
}

const SALON_1: SalonOpeningHoursEntry = {
  salonId: "salon-1",
  name: "Salon Eins",
  openingHours: hours([2, 6]),
};
const SALON_2: SalonOpeningHoursEntry = {
  salonId: "salon-2",
  name: "Salon Zwei",
  openingHours: hours([0]),
};

function state(overrides: Partial<SalonContextState> = {}): SalonContextState {
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
    ...overrides,
  };
}

describe("closedDaysFor", () => {
  it("shows nothing and no hint without a week field or with an empty one", () => {
    const empty = { days: new Set<number>(), salonName: null, hint: null };
    expect(closedDaysFor(undefined, state())).toEqual(empty);
    expect(closedDaysFor([], state())).toEqual(empty);
  });

  it("one salon in the field: its closed weekdays and name, whatever the selection", () => {
    for (const selection of [ALL_SALONS, "salon-2", null]) {
      const view = closedDaysFor([SALON_1], state({ selection }));
      expect([...view.days].sort()).toEqual([2, 6]);
      expect(view.salonName).toBe("Salon Eins");
      expect(view.hint).toBeNull();
    }
  });

  it("several salons and a chosen listed salon: that salon's days and name", () => {
    const view = closedDaysFor([SALON_1, SALON_2], state({ selection: "salon-2" }));
    expect([...view.days]).toEqual([0]);
    expect(view.salonName).toBe("Salon Zwei");
    expect(view.hint).toBeNull();
  });

  it("several salons and „Alle Salons“ with a choice offered: nothing dimmed, the hint", () => {
    const view = closedDaysFor([SALON_1, SALON_2], state({ selection: ALL_SALONS }));
    expect(view.days.size).toBe(0);
    expect(view.salonName).toBeNull();
    expect(view.hint).toBe(
      "Öffnungszeiten je Salon – Salon wählen, um geschlossene Tage zu sehen.",
    );
    expect(view.hint).toBe(SALON_HOURS_CHOOSE_HINT);
  });

  it("several salons but no choice offered: nothing dimmed and no hint", () => {
    const view = closedDaysFor(
      [SALON_1, SALON_2],
      state({ isMultiSalon: false, salons: [], selection: null }),
    );
    expect(view.days.size).toBe(0);
    expect(view.salonName).toBeNull();
    expect(view.hint).toBeNull();
  });

  it("a selection that is not in the week field (context reach wider than shift reach) behaves like „Alle Salons“", () => {
    const view = closedDaysFor(
      [SALON_1, SALON_2],
      state({
        selection: "salon-3",
        salons: [
          { id: "salon-1", name: "Salon Eins" },
          { id: "salon-2", name: "Salon Zwei" },
          { id: "salon-3", name: "Salon Drei" },
        ],
      }),
    );
    expect(view.days.size).toBe(0);
    expect(view.salonName).toBeNull();
    expect(view.hint).toBe(SALON_HOURS_CHOOSE_HINT);
  });

  it("never merges: the union of two salons' closed days is not a possible answer", () => {
    for (const selection of [ALL_SALONS, "salon-1", "salon-2"]) {
      const view = closedDaysFor([SALON_1, SALON_2], state({ selection }));
      expect(view.days.size).toBeLessThanOrEqual(2);
      expect(view.days.has(0) && view.days.has(2)).toBe(false);
    }
  });

  it("malformed hours are no closed day and never throw; only closed === true counts", () => {
    const malformed: SalonOpeningHoursEntry[] = [
      { salonId: "salon-1", name: "Salon Eins", openingHours: "kaputt" },
    ];
    expect(closedDaysFor(malformed, state()).days.size).toBe(0);
    const partial: SalonOpeningHoursEntry[] = [
      {
        salonId: "salon-1",
        name: "Salon Eins",
        openingHours: [
          null,
          { open: "09:00", close: "18:00", closed: true },
          { day: "3", closed: true },
          { day: 4, closed: "true" },
          { day: 9, closed: true },
          { day: 1, closed: false },
          { day: 5, closed: true },
        ],
      },
    ];
    const view = closedDaysFor(partial, state());
    expect([...view.days]).toEqual([5]);
    expect(view.salonName).toBe("Salon Eins");
  });
});

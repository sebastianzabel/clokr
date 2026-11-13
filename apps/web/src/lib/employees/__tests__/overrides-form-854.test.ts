// Issue #854 (plan 854-22) - the pure model of the per-person overrides: values, bounds, the
// under-18 rule, the inheritance wording of the Berufsschule slots.
import { describe, expect, it } from "vitest";

import {
  BS_SLOT_KEYS,
  PAUSE_KEYS,
  PHOREST_KEYS,
  ageOn,
  bsSlotMessages,
  bsSlotValuesOf,
  inheritedFrom,
  isUnder18,
  minutesError,
  overCreditNotice,
  pauseMessages,
  pauseValuesOf,
  phorestMessages,
  phorestValuesOf,
  type BsSlotValues,
} from "../overrides-form";

describe("values of a stored person", () => {
  it("maps absent and null to null (inherit) and keeps a stored 0", () => {
    expect(pauseValuesOf({})).toEqual({ breakOver6hOverride: null, breakOver9hOverride: null });
    expect(
      phorestValuesOf({ phorestPrepMinutesOverride: 0, phorestWrapupMinutesOverride: null }),
    ).toEqual({ phorestPrepMinutesOverride: 0, phorestWrapupMinutesOverride: null });
    expect(bsSlotValuesOf({ bsSlotShortDayMinutes: 300 }).bsSlotShortDayMinutes).toBe(300);
  });

  it("each group owns exactly its own keys", () => {
    const all = [...PAUSE_KEYS, ...PHOREST_KEYS, ...BS_SLOT_KEYS];
    expect(new Set(all).size).toBe(all.length);
    expect(PAUSE_KEYS).toHaveLength(2);
    expect(PHOREST_KEYS).toHaveLength(2);
    expect(BS_SLOT_KEYS).toHaveLength(4);
  });
});

describe("bounds", () => {
  it("empty is always fine, the API bounds are inclusive", () => {
    expect(minutesError(null, { min: 30, max: 120 })).toBeUndefined();
    expect(minutesError(30, { min: 30, max: 120 })).toBeUndefined();
    expect(minutesError(120, { min: 30, max: 120 })).toBeUndefined();
  });

  it("names the bounds when a value is outside, and refuses a fraction", () => {
    expect(minutesError(29, { min: 30, max: 120 })).toBe(
      "Der Wert muss zwischen 30 und 120 Minuten liegen.",
    );
    expect(minutesError(121, { min: 30, max: 120 })).toContain("120");
    expect(minutesError(45.5, { min: 30, max: 120 })).toBe("Bitte eine ganze Zahl eingeben.");
  });

  it("Pausendauer: > 6 h 30-120, > 9 h 45-180", () => {
    expect(pauseMessages({ breakOver6hOverride: 20, breakOver9hOverride: 44 })).toEqual({
      breakOver6hOverride: "Der Wert muss zwischen 30 und 120 Minuten liegen.",
      breakOver9hOverride: "Der Wert muss zwischen 45 und 180 Minuten liegen.",
    });
    expect(pauseMessages({ breakOver6hOverride: 60, breakOver9hOverride: 60 })).toEqual({});
  });

  it("Phorest: 0-30, a stored 0 is an explicit „no puffer“", () => {
    expect(
      phorestMessages({ phorestPrepMinutesOverride: 0, phorestWrapupMinutesOverride: 31 }),
    ).toEqual({ phorestWrapupMinutesOverride: "Der Wert muss zwischen 0 und 30 Minuten liegen." });
  });

  it("Berufsschule: day slots 240-600, block week 1200-3000", () => {
    const values: BsSlotValues = {
      bsSlotFirstLongDayMinutes: 239,
      bsSlotSecondLongDayMinutes: 600,
      bsSlotShortDayMinutes: null,
      bsSlotBlockWeekMinutes: 3001,
    };
    expect(Object.keys(bsSlotMessages(values)).sort()).toEqual([
      "bsSlotBlockWeekMinutes",
      "bsSlotFirstLongDayMinutes",
    ]);
  });
});

describe("under 18 (§ 11 JArbSchG)", () => {
  const now = new Date(2026, 10, 12);

  it("counts full years and flips on the birthday", () => {
    expect(ageOn("2008-11-12", now)).toBe(18);
    expect(ageOn("2008-11-13", now)).toBe(17);
    expect(ageOn("2010-01-01", now)).toBe(16);
  });

  it("is decided from the birth day alone", () => {
    expect(isUnder18("2010-05-05", now)).toBe(true);
    expect(isUnder18("2008-11-12", now)).toBe(false);
  });

  it("no or an unreadable birth date reads as not under 18", () => {
    expect(isUnder18(null, now)).toBe(false);
    expect(isUnder18("", now)).toBe(false);
    expect(isUnder18("kein-datum", now)).toBe(false);
  });
});

describe("inheritance wording of the Berufsschule slots", () => {
  it("names the first lower layer that holds a value", () => {
    expect(inheritedFrom({ pattern: 480, tenant: 420, dailySoll: 360 }, false)).toBe(
      "Erbt aus: Muster = 480 Min (8 h)",
    );
    expect(inheritedFrom({ pattern: null, tenant: 450, dailySoll: 360 }, false)).toBe(
      "Erbt aus: Unternehmen = 450 Min (7,5 h)",
    );
    expect(inheritedFrom({ pattern: null, tenant: null, dailySoll: 360 }, false)).toBe(
      "Erbt aus: Tages-Soll = 360 Min (6 h)",
    );
  });

  it("a block week never falls back to the daily Soll", () => {
    expect(inheritedFrom({ pattern: null, tenant: null, dailySoll: 360 }, true)).toBe(
      "Erbt aus: Wochenstunden-Soll der Person",
    );
    expect(inheritedFrom({ pattern: null, tenant: null, dailySoll: null }, false)).toBe(
      "Erbt aus: Tages-Soll der Person",
    );
  });
});

describe("over-credit notice", () => {
  const layers = { pattern: null, tenant: null, dailySoll: 480 };

  it("fires when the 2nd long day exceeds the effective 1st one", () => {
    expect(overCreditNotice(540, 480, layers)).toContain("übersteigt den 1. Langtag");
    // own 1st value wins over the lower layers
    expect(overCreditNotice(500, 400, layers)).not.toBe("");
    expect(overCreditNotice(500, 520, layers)).toBe("");
    // without an own 1st value the daily Soll of the lowest layer applies
    expect(overCreditNotice(500, null, layers)).not.toBe("");
    expect(overCreditNotice(480, null, layers)).toBe("");
  });

  it("stays silent without a 2nd value or an unknown 1st long day", () => {
    expect(overCreditNotice(null, 480, layers)).toBe("");
    expect(overCreditNotice(540, null, { pattern: null, tenant: null, dailySoll: null })).toBe("");
  });
});

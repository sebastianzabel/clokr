// Issue #89 (D-10) - the opening-hours helpers of the salon form.
import { describe, expect, it } from "vitest";

import {
  DAY_NAMES,
  HOURS_MISSING_MESSAGE,
  HOURS_ORDER_MESSAGE,
  defaultOpeningHours,
  isValidPostalCode,
  prefillOpeningHours,
  validateOpeningHours,
} from "../opening-hours";
import type { OpeningHoursDay } from "../types";

describe("DAY_NAMES", () => {
  it("starts on Montag (index 0) and ends on Sonntag", () => {
    expect(DAY_NAMES).toHaveLength(7);
    expect(DAY_NAMES[0]).toBe("Montag");
    expect(DAY_NAMES[6]).toBe("Sonntag");
  });
});

describe("defaultOpeningHours", () => {
  it("is Montag-Freitag 09:00-18:00 open, Samstag and Sonntag closed, with explicit times", () => {
    const hours = defaultOpeningHours();
    expect(hours.map((d) => d.day)).toEqual([0, 1, 2, 3, 4, 5, 6]);
    for (const entry of hours) {
      expect(entry.open).toBe("09:00");
      expect(entry.close).toBe("18:00");
    }
    expect(hours.slice(0, 5).every((d) => d.closed === false)).toBe(true);
    expect(hours[5]?.closed).toBe(true);
    expect(hours[6]?.closed).toBe(true);
  });

  it("returns a fresh array each call", () => {
    const a = defaultOpeningHours();
    const first = a[0] as OpeningHoursDay;
    first.open = "10:00";
    expect(defaultOpeningHours()[0]?.open).toBe("09:00");
  });
});

describe("prefillOpeningHours", () => {
  const stored: OpeningHoursDay[] = [
    { day: 0, open: "08:00", close: "20:00" },
    { day: 1, open: "08:00", close: "20:00" },
    { day: 2, open: "08:00", close: "20:00" },
    { day: 3, open: "08:00", close: "20:00" },
    { day: 4, open: "08:00", close: "20:00" },
    { day: 5, open: "10:00", close: "16:00" },
    { day: 6, open: "08:00", close: "20:00", closed: true },
  ];

  it("copies the default salon's hours and normalises closed", () => {
    const copy = prefillOpeningHours({ openingHours: stored });
    expect(copy).toHaveLength(7);
    expect(copy[0]).toEqual({ day: 0, open: "08:00", close: "20:00", closed: false });
    expect(copy[5]).toEqual({ day: 5, open: "10:00", close: "16:00", closed: false });
    expect(copy[6]).toEqual({ day: 6, open: "08:00", close: "20:00", closed: true });
  });

  it("is a deep copy: mutating it leaves the source unchanged", () => {
    const source = structuredClone(stored);
    const copy = prefillOpeningHours({ openingHours: source });
    const monday = copy[0] as OpeningHoursDay;
    monday.open = "07:00";
    monday.closed = true;
    expect(source).toEqual(stored);
  });

  it("copies only the four wire fields", () => {
    const withExtra = stored.map((d) => ({ ...d, note: "x" }));
    const copy = prefillOpeningHours({ openingHours: withExtra });
    for (const entry of copy)
      expect(Object.keys(entry).sort()).toEqual(["close", "closed", "day", "open"]);
  });

  it("orders the copy by day even when the source is shuffled", () => {
    const shuffled = [...stored].reverse();
    expect(prefillOpeningHours({ openingHours: shuffled }).map((d) => d.day)).toEqual([
      0, 1, 2, 3, 4, 5, 6,
    ]);
  });

  it("falls back to the default without a salon or without seven valid entries", () => {
    expect(prefillOpeningHours(null)).toEqual(defaultOpeningHours());
    expect(prefillOpeningHours(undefined)).toEqual(defaultOpeningHours());
    expect(prefillOpeningHours({ openingHours: [] })).toEqual(defaultOpeningHours());
    expect(prefillOpeningHours({ openingHours: stored.slice(0, 6) })).toEqual(
      defaultOpeningHours(),
    );
    const duplicated = stored.map((d) => ({ ...d, day: 0 }));
    expect(prefillOpeningHours({ openingHours: duplicated })).toEqual(defaultOpeningHours());
    const badTime = stored.map((d, i) => (i === 2 ? { ...d, open: "8:00" } : d));
    expect(prefillOpeningHours({ openingHours: badTime })).toEqual(defaultOpeningHours());
  });
});

describe("validateOpeningHours", () => {
  it("accepts the default", () => {
    expect(validateOpeningHours(defaultOpeningHours())).toEqual({});
  });

  it("reports an open day whose opening is not before its closing", () => {
    const days = defaultOpeningHours();
    (days[1] as OpeningHoursDay).open = "18:00";
    (days[3] as OpeningHoursDay).open = "19:00";
    expect(validateOpeningHours(days)).toEqual({
      1: HOURS_ORDER_MESSAGE,
      3: HOURS_ORDER_MESSAGE,
    });
    expect(HOURS_ORDER_MESSAGE).toBe("Die Öffnungszeit muss vor der Schließzeit liegen.");
  });

  it("ignores a closed day whatever its times are", () => {
    const days = defaultOpeningHours();
    Object.assign(days[5] as OpeningHoursDay, { open: "20:00", close: "08:00", closed: true });
    expect(validateOpeningHours(days)).toEqual({});
  });

  it("reports an open day with a cleared time", () => {
    const days = defaultOpeningHours();
    (days[2] as OpeningHoursDay).close = "";
    expect(validateOpeningHours(days)).toEqual({ 2: HOURS_MISSING_MESSAGE });
  });
});

describe("isValidPostalCode", () => {
  it("accepts empty and five digits", () => {
    expect(isValidPostalCode("")).toBe(true);
    expect(isValidPostalCode("12345")).toBe(true);
    expect(isValidPostalCode("01067")).toBe(true);
  });

  it("rejects everything else", () => {
    for (const bad of ["1234", "123456", "12a45", " 12345", "12 45"]) {
      expect(isValidPostalCode(bad), bad).toBe(false);
    }
  });
});

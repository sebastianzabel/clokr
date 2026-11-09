// Issue #853 (D-853-08, D-853-09) - the sentences of the leave decision dialog. Every expected
// string is written out by hand.
import { describe, expect, it } from "vitest";
import {
  formatDays,
  NO_SHIFTS_TEXT,
  reviewResultToast,
  shiftLines,
  vacationBeforeAfter,
} from "../review-facts";

describe("reviewResultToast", () => {
  it.each([
    ["APPROVED", false, "Antrag von Alex Muster genehmigt."],
    ["REJECTED", false, "Antrag von Alex Muster abgelehnt."],
    ["APPROVED", true, "Stornierung von Alex Muster genehmigt."],
    ["REJECTED", true, "Stornierung von Alex Muster abgelehnt."],
  ] as const)("%s, cancellation %s", (decision, cancellation, expected) => {
    expect(reviewResultToast(decision, "Alex Muster", cancellation)).toBe(expected);
  });

  it("defaults to a request, not a cancellation", () => {
    expect(reviewResultToast("APPROVED", "Alex Muster")).toBe("Antrag von Alex Muster genehmigt.");
  });

  it("has no parameter for the leave type, so it cannot name one (Art. 9 DSGVO)", () => {
    expect(reviewResultToast.length).toBeLessThanOrEqual(3);
    expect(reviewResultToast("APPROVED", "Alex Muster")).not.toMatch(/krank|urlaub|sick/i);
  });
});

describe("formatDays", () => {
  it.each([
    [5, "5"],
    [7.5, "7,5"],
    [0.5, "0,5"],
    [-1, "-1"],
    [12.345, "12,35"],
    [0, "0"],
  ])("%s -> %s", (value, expected) => {
    expect(formatDays(value)).toBe(expected);
  });
});

describe("vacationBeforeAfter", () => {
  const base = {
    remaining: 12,
    days: 5,
    status: "PENDING",
    startDate: "2026-09-01",
    endDate: "2026-09-05",
  };

  it("derives before -> after for a pending request inside one year", () => {
    expect(vacationBeforeAfter(base)).toEqual({
      year: 2026,
      before: 12,
      after: 7,
      text: "Resturlaub 2026: 12 → 7 Tage",
    });
  });

  it("uses the decimal comma for half days", () => {
    expect(vacationBeforeAfter({ ...base, remaining: 12.5, days: 0.5 })?.text).toBe(
      "Resturlaub 2026: 12,5 → 12 Tage",
    );
  });

  it("shows a negative result as it is (the approver decides)", () => {
    expect(vacationBeforeAfter({ ...base, remaining: 3 })?.after).toBe(-2);
  });

  it("derives no number for a request that spans the turn of the year (Pitfall 6)", () => {
    const fact = vacationBeforeAfter({ ...base, startDate: "2026-12-29", endDate: "2027-01-02" });
    expect(fact).toEqual({ year: 2026, before: 12, after: null, text: "Resturlaub 2026: 12 Tage" });
  });

  it("derives no number for a request that is no longer pending (already deducted)", () => {
    const fact = vacationBeforeAfter({ ...base, status: "CANCELLATION_REQUESTED" });
    expect(fact?.after).toBeNull();
    expect(fact?.text).toBe("Resturlaub 2026: 12 Tage");
  });

  it("is null without a balance", () => {
    expect(vacationBeforeAfter({ ...base, remaining: null })).toBeNull();
  });
});

describe("shiftLines", () => {
  it("formats weekday, day, month and times", () => {
    expect(shiftLines([{ date: "2026-11-10", startTime: "10:00", endTime: "18:30" }])).toEqual([
      "Di 10.11. · 10:00–18:30",
    ]);
  });

  it("orders by date and start time without mutating the input", () => {
    const input = [
      { date: "2026-11-11", startTime: "09:00", endTime: "13:00" },
      { date: "2026-11-10", startTime: "14:00", endTime: "18:00" },
      { date: "2026-11-10", startTime: "08:00", endTime: "12:00" },
    ];
    const copy = JSON.stringify(input);
    expect(shiftLines(input)).toEqual([
      "Di 10.11. · 08:00–12:00",
      "Di 10.11. · 14:00–18:00",
      "Mi 11.11. · 09:00–13:00",
    ]);
    expect(JSON.stringify(input)).toBe(copy);
  });

  it("names Sunday and pads a single-digit day", () => {
    expect(shiftLines([{ date: "2026-11-01", startTime: "10:00", endTime: "14:00" }])).toEqual([
      "So 01.11. · 10:00–14:00",
    ]);
  });

  it("is empty for no shifts and the neutral text never says the person has none", () => {
    expect(shiftLines([])).toEqual([]);
    expect(NO_SHIFTS_TEXT).toBe("Keine geplanten Schichten sichtbar");
  });
});

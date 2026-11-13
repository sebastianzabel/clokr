// Issue #854 (owner review): a month the API reports as `future` reads „Läuft noch“ while it is the current
// month and „Zukunft“ when it lies later; the decision is the month against today, never a display string.
import { describe, expect, it } from "vitest";
import { NOT_ENDED_MONTH_LABEL, notEndedMonthLabel } from "$lib/saldo/month-status";

describe("notEndedMonthLabel", () => {
  it("names the current month „Läuft noch“", () => {
    expect(notEndedMonthLabel(2026, 11, "2026-11-13")).toBe("Läuft noch");
  });
  it("names a later month „Zukunft“, also across a year", () => {
    expect(notEndedMonthLabel(2026, 12, "2026-11-13")).toBe("Zukunft");
    expect(notEndedMonthLabel(2027, 1, "2026-12-31")).toBe(NOT_ENDED_MONTH_LABEL.LATER);
  });
  it("judges the month of the given day, not the year alone", () => {
    expect(notEndedMonthLabel(2026, 11, "2027-11-01")).toBe("Zukunft");
  });
});

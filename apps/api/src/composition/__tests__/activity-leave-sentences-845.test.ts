// Issue #845 (D-05) — the history sentence of an own leave request is one complete German sentence.
import { describe, it, expect } from "vitest";
import { leaveActivitySentence } from "../activity-sentences";

const d = (s: string) => new Date(`${s}T00:00:00.000Z`);

describe("leaveActivitySentence", () => {
  it("names type and period and says what happened", () => {
    const s = leaveActivitySentence({
      status: "APPROVED",
      startDate: d("2026-12-21"),
      endDate: d("2026-12-23"),
      typeName: "Urlaub",
    });
    expect(`${s.who} ${s.what}`).toBe("Dein Antrag (Urlaub, 21.12.–23.12.) wurde genehmigt.");
  });
  it("a one-day request names one day; every status ends in a full stop", () => {
    for (const status of ["PENDING", "REJECTED", "CANCELLED", "CANCELLATION_REQUESTED"]) {
      const s = leaveActivitySentence({
        status,
        startDate: d("2026-11-16"),
        endDate: d("2026-11-16"),
        typeName: "Krankmeldung",
      });
      expect(`${s.who} ${s.what}`).toMatch(/^Dein Antrag \(Krankmeldung, 16\.11\.\) .+\.$/);
    }
  });
  it("reads the calendar day without a zone shift (#493)", () => {
    const s = leaveActivitySentence({
      status: "PENDING",
      startDate: d("2026-03-01"),
      endDate: d("2026-03-01"),
      typeName: "Urlaub",
    });
    expect(s.what).toContain("01.03.");
  });
});

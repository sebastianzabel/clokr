/**
 * Issue #446 (D-07/D-08) — pure unit tests for the two new closed-month helpers in
 * `correction-lock.ts`: `monthsInRange` (the distinct-months walk) and
 * `closedMonthLeaveMessage` (the shared 409 message builder). DB-free — no Prisma, no I/O,
 * matching the module's own purity contract.
 */
import { describe, it, expect } from "vitest";
import { monthsInRange, closedMonthLeaveMessage } from "../correction-lock";

describe("monthsInRange (Issue #446, D-07)", () => {
  it("a range inside one month returns that single month", () => {
    expect(
      monthsInRange(new Date("2026-03-09T00:00:00Z"), new Date("2026-03-13T00:00:00Z")),
    ).toEqual([{ year: 2026, month: 3 }]);
  });

  it("a range spanning two months returns both, ascending", () => {
    expect(
      monthsInRange(new Date("2026-03-30T00:00:00Z"), new Date("2026-04-03T00:00:00Z")),
    ).toEqual([
      { year: 2026, month: 3 },
      { year: 2026, month: 4 },
    ]);
  });

  it("a range spanning a year boundary returns both, ascending, distinct", () => {
    expect(
      monthsInRange(new Date("2026-12-28T00:00:00Z"), new Date("2027-01-04T00:00:00Z")),
    ).toEqual([
      { year: 2026, month: 12 },
      { year: 2027, month: 1 },
    ]);
  });
});

describe("closedMonthLeaveMessage (Issue #446, D-08)", () => {
  it("singular, kind=request", () => {
    expect(closedMonthLeaveMessage([{ year: 2026, month: 9 }], "request")).toBe(
      "Der Zeitraum enthält den abgeschlossenen Monat 09/2026. Dafür kann keine Abwesenheit beantragt werden, solange der Monat nicht wieder entsperrt ist.",
    );
  });

  it("singular, kind=change", () => {
    expect(closedMonthLeaveMessage([{ year: 2026, month: 9 }], "change")).toBe(
      "Der Zeitraum enthält den abgeschlossenen Monat 09/2026. Nach dem Monatsabschluss ist diese Änderung dort nicht möglich, solange der Monat nicht wieder entsperrt ist.",
    );
  });

  it("plural (two months) names both, joined with 'und', plural verb form", () => {
    const msg = closedMonthLeaveMessage(
      [
        { year: 2026, month: 8 },
        { year: 2026, month: 9 },
      ],
      "request",
    );
    expect(msg).toContain("Der Zeitraum enthält die abgeschlossenen Monate 08/2026 und 09/2026.");
    expect(msg).toContain("solange die Monate nicht wieder entsperrt sind.");
  });

  it("plural (three months) joins as 'A, B und C'", () => {
    const msg = closedMonthLeaveMessage(
      [
        { year: 2026, month: 7 },
        { year: 2026, month: 8 },
        { year: 2026, month: 9 },
      ],
      "change",
    );
    expect(msg).toContain("07/2026, 08/2026 und 09/2026");
  });

  it("none of the four variants promises a 'Korrekturbuchung' (D-08)", () => {
    const variants = [
      closedMonthLeaveMessage([{ year: 2026, month: 9 }], "request"),
      closedMonthLeaveMessage([{ year: 2026, month: 9 }], "change"),
      closedMonthLeaveMessage(
        [
          { year: 2026, month: 8 },
          { year: 2026, month: 9 },
        ],
        "request",
      ),
      closedMonthLeaveMessage(
        [
          { year: 2026, month: 8 },
          { year: 2026, month: 9 },
        ],
        "change",
      ),
    ];
    for (const v of variants) expect(v).not.toContain("Korrekturbuchung");
  });
});

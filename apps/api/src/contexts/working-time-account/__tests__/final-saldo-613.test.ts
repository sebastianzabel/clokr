/**
 * Issue #613 (AC-613-5): `finalSaldoOpen` decides whether the month of an exit is still open
 * from the latest closed snapshot's `periodEnd`, for both storage conventions.
 */
import { describe, it, expect } from "vitest";
import { finalSaldoOpen } from "../final-saldo";

const BERLIN = "Europe/Berlin";
const NEW_YORK = "America/New_York";
const exit = new Date("2026-10-15T00:00:00.000Z");

describe("finalSaldoOpen (Issue #613, AC-613-5)", () => {
  it("is open when no month has been closed at all", () => {
    expect(finalSaldoOpen({ exitDate: exit, latestClosedPeriodEnd: null, tz: BERLIN })).toBe(true);
  });

  it("is open when the latest closed month is the month before the exit (legacy row)", () => {
    const periodEnd = new Date("2026-09-30T00:00:00.000Z");
    expect(finalSaldoOpen({ exitDate: exit, latestClosedPeriodEnd: periodEnd, tz: BERLIN })).toBe(
      true,
    );
  });

  it("is closed when the exit month is the latest closed month (legacy row)", () => {
    const periodEnd = new Date("2026-10-31T00:00:00.000Z");
    expect(finalSaldoOpen({ exitDate: exit, latestClosedPeriodEnd: periodEnd, tz: BERLIN })).toBe(
      false,
    );
  });

  it("is closed for a TZ-converted October row (periodEnd date 2026-10-31)", () => {
    // monthRangeUtc end of October in Berlin is 2026-10-31T22:59:59.999Z, stored as the DATE 2026-10-31.
    const periodEnd = new Date("2026-10-31T00:00:00.000Z");
    expect(finalSaldoOpen({ exitDate: exit, latestClosedPeriodEnd: periodEnd, tz: BERLIN })).toBe(
      false,
    );
  });

  it("is closed for the same October row in a zone west of UTC (end instant on the 1st of November UTC)", () => {
    // New York: the month's last instant is 2026-11-01T03:59:59.999Z, stored as the DATE 2026-11-01.
    const periodEnd = new Date("2026-11-01T00:00:00.000Z");
    expect(finalSaldoOpen({ exitDate: exit, latestClosedPeriodEnd: periodEnd, tz: NEW_YORK })).toBe(
      false,
    );
    // And the plain legacy date in that zone.
    const legacy = new Date("2026-10-31T00:00:00.000Z");
    expect(finalSaldoOpen({ exitDate: exit, latestClosedPeriodEnd: legacy, tz: NEW_YORK })).toBe(
      false,
    );
  });

  it("is open for a TZ-converted September row in a zone west of UTC", () => {
    const periodEnd = new Date("2026-10-01T00:00:00.000Z");
    expect(finalSaldoOpen({ exitDate: exit, latestClosedPeriodEnd: periodEnd, tz: NEW_YORK })).toBe(
      true,
    );
  });

  it("is open for a TZ-converted September row in Berlin (periodEnd date 2026-09-30)", () => {
    const periodEnd = new Date("2026-09-30T00:00:00.000Z");
    expect(finalSaldoOpen({ exitDate: exit, latestClosedPeriodEnd: periodEnd, tz: BERLIN })).toBe(
      true,
    );
  });

  it("is closed when a later month than the exit month has been closed", () => {
    const periodEnd = new Date("2026-12-31T00:00:00.000Z");
    expect(finalSaldoOpen({ exitDate: exit, latestClosedPeriodEnd: periodEnd, tz: BERLIN })).toBe(
      false,
    );
  });
});

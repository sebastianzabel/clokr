import { describe, it, expect, vi, afterEach } from "vitest";
import { addDaysUtc, startOfDayUtc, dateStrInTz } from "../contexts/working-time-account";
import { daysAgoStrInTz } from "./test-dates";

/**
 * Issue #172: calendar-day arithmetic must not drift across DST. Run under both
 * `TZ=Europe/Berlin` and `TZ=UTC` (`TZ=Europe/Berlin pnpm exec vitest run <this file>`).
 */
const TZ = "Europe/Berlin";

describe("daysAgoStrInTz across DST (Issue #172)", () => {
  // 2026-10-25 has 25 hours in Europe/Berlin (CEST -> CET at 03:00 local).
  it("last hour of the 25 h day: 1 day ago is the previous calendar day", () => {
    const now = new Date("2026-10-25T22:30:00Z"); // 23:30 CET on 25 Oct
    expect(dateStrInTz(now, TZ)).toBe("2026-10-25");
    expect(daysAgoStrInTz(now, 1, TZ)).toBe("2026-10-24");
    expect(daysAgoStrInTz(now, 2, TZ)).toBe("2026-10-23");
  });
  it("first hour after the 23 h day: 1 day ago is the previous calendar day", () => {
    const now = new Date("2026-03-29T22:30:00Z"); // 00:30 CEST on 30 Mar
    expect(dateStrInTz(now, TZ)).toBe("2026-03-30");
    expect(daysAgoStrInTz(now, 1, TZ)).toBe("2026-03-29");
    expect(daysAgoStrInTz(now, 2, TZ)).toBe("2026-03-28");
  });
  it("every hour of both switch days steps back exactly one local day", () => {
    for (const day of ["2026-03-29", "2026-10-25"]) {
      for (let h = -3; h < 30; h++) {
        const now = new Date(new Date(`${day}T00:00:00Z`).getTime() + h * 3600_000);
        const local = dateStrInTz(now, TZ);
        const expected = new Date(new Date(`${local}T00:00:00Z`).getTime() - 86_400_000)
          .toISOString()
          .slice(0, 10);
        expect(daysAgoStrInTz(now, 1, TZ)).toBe(expected);
      }
    }
  });
});

describe("addDaysUtc / startOfDayUtc (Issue #172)", () => {
  it("adds whole calendar days over both switch dates, preserving time of day", () => {
    expect(addDaysUtc(new Date("2026-03-28T00:00:00Z"), 2).toISOString()).toBe(
      "2026-03-30T00:00:00.000Z",
    );
    expect(addDaysUtc(new Date("2026-10-26T00:00:00Z"), -2).toISOString()).toBe(
      "2026-10-24T00:00:00.000Z",
    );
    expect(addDaysUtc(new Date("2026-10-24T01:30:00Z"), 1).toISOString()).toBe(
      "2026-10-25T01:30:00.000Z",
    );
  });
  it("does not mutate its input", () => {
    const d = new Date("2026-03-29T00:00:00Z");
    addDaysUtc(d, 5);
    expect(d.toISOString()).toBe("2026-03-29T00:00:00.000Z");
  });
  it("168-day ArbZG window start is host-TZ independent", () => {
    const changed = new Date("2026-10-26T00:00:00Z");
    expect(startOfDayUtc(addDaysUtc(changed, -167)).toISOString()).toBe("2026-05-12T00:00:00.000Z");
  });
  it("startOfDayUtc is the UTC midnight, whatever the host TZ", () => {
    expect(startOfDayUtc(new Date("2026-10-25T23:59:00Z")).toISOString()).toBe(
      "2026-10-25T00:00:00.000Z",
    );
  });
});

describe("retention cutoff style (Issue #172)", () => {
  afterEach(() => vi.useRealTimers());
  it("90 days before 2026-10-26 12:00Z is 2026-07-28 12:00Z in any host TZ", () => {
    vi.useFakeTimers({ now: new Date("2026-10-26T12:00:00Z") });
    expect(addDaysUtc(new Date(), -90).toISOString()).toBe("2026-07-28T12:00:00.000Z");
  });
});

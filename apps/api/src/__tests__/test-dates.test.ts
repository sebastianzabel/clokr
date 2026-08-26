/**
 * Pure unit test for `test-dates.ts` (issue #34) — no DB, no `getTestApp`.
 * Must pass at ANY real hour and under ANY fake clock (see
 * `vitest.clock-setup.ts`); this is what makes it usable as the RED/GREEN
 * proof for the tenant-timezone date bug.
 */
import { describe, it, expect } from "vitest";
import { fromZonedTime } from "date-fns-tz";
import {
  TEST_TZ,
  dbDateStr,
  utcMidnight,
  todayStr,
  pastDateStr,
  futureDateStr,
  dowOf,
  nextWeekdayStr,
} from "./test-dates";
import { dateStrInTz } from "../utils/timezone";
import { computeRetroLimitStr } from "../utils/retro-config";

describe("test-dates helper", () => {
  it("TEST_TZ mirrors the tenant timezone seeded in setup.ts:61", () => {
    expect(TEST_TZ).toBe("Europe/Berlin");
  });

  it("pastDateStr(10) agrees with the production retro-window math by construction", () => {
    expect(pastDateStr(10)).toBe(computeRetroLimitStr(TEST_TZ, 10));
  });

  it("todayStr() agrees with dateStrInTz(new Date(), TEST_TZ)", () => {
    expect(todayStr()).toBe(dateStrInTz(new Date(), TEST_TZ));
  });

  it("pastDateStr(0) === todayStr()", () => {
    expect(pastDateStr(0)).toBe(todayStr());
  });

  it("futureDateStr(1) is exactly one day after todayStr()", () => {
    const diff = utcMidnight(futureDateStr(1)).getTime() - utcMidnight(todayStr()).getTime();
    expect(diff).toBe(86_400_000);
  });

  it("dbDateStr reads a stored @db.Date value in UTC, not the tenant TZ", () => {
    expect(dbDateStr(new Date("2026-06-03T00:00:00Z"))).toBe("2026-06-03");
  });

  it("dowOf reads the weekday off the date string", () => {
    expect(dowOf("2026-08-26")).toBe(3); // Wednesday
  });

  it("nextWeekdayStr advances a weekend date to the next weekday", () => {
    expect(nextWeekdayStr("2026-08-29")).toBe("2026-08-31"); // Sat -> Mon
  });

  // Fake-clock propagation: proves the shift installed by vitest.clock-setup.ts
  // actually reached this worker. Gated by `if`, not `it.skip`, so the default
  // (no fake clock) run is unaffected.
  if (process.env.CLOKR_TEST_FAKE_CLOCK) {
    it("Date.now() reflects the CLOKR_TEST_FAKE_CLOCK shift", () => {
      const spec = process.env.CLOKR_TEST_FAKE_CLOCK!;
      const tz = process.env.CLOKR_TEST_FAKE_CLOCK_TZ ?? "Europe/Berlin";
      const today = dateStrInTz(new Date(), tz);
      const expected = fromZonedTime(`${today}T${spec}:00`, tz).getTime();
      expect(Math.abs(Date.now() - expected)).toBeLessThan(60_000);
    });
  }
});

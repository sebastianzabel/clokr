/**
 * Pure unit test for `test-dates.ts` (issue #34) — no DB, no `getTestApp`.
 * Must pass at ANY real hour and under ANY fake clock (see
 * `vitest.clock-setup.ts`); this is what makes it usable as the RED/GREEN
 * proof for the tenant-timezone date bug.
 */
import { describe, it, expect, vi, afterEach } from "vitest";
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
  monthStartUtc,
  monthEndUtc,
  saldoSnapshotPeriodBounds,
} from "./test-dates";
import { dateStrInTz, monthRangeUtc } from "../contexts/working-time-account/timezone";
import { computeRetroLimitStr } from "../contexts/time-tracking/retro-config";

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

  describe("monthStartUtc / monthEndUtc", () => {
    afterEach(() => {
      vi.useRealTimers();
    });

    it("pins the day-31 regression: monthStartUtc(1) and monthStartUtc(2) are distinct on 2026-08-31", () => {
      vi.setSystemTime(new Date("2026-08-31T12:00:00Z"));
      expect(monthStartUtc(1).toISOString()).toBe("2026-07-01T00:00:00.000Z");
      expect(monthStartUtc(2).toISOString()).toBe("2026-06-01T00:00:00.000Z");
    });

    it("pins a second day-31 case: monthStartUtc(1) and monthStartUtc(2) are distinct on 2026-05-31", () => {
      vi.setSystemTime(new Date("2026-05-31T12:00:00Z"));
      expect(monthStartUtc(1).toISOString()).toBe("2026-04-01T00:00:00.000Z");
      expect(monthStartUtc(2).toISOString()).toBe("2026-03-01T00:00:00.000Z");
    });

    it("produces 13 distinct, normalised month starts for n=0..12 on 2026-08-31", () => {
      vi.setSystemTime(new Date("2026-08-31T12:00:00Z"));
      const starts = Array.from({ length: 13 }, (_, n) => monthStartUtc(n));
      const isoSet = new Set(starts.map((d) => d.toISOString()));
      expect(isoSet.size).toBe(13);
      for (const d of starts) {
        expect(d.getUTCDate()).toBe(1);
        expect(d.getUTCHours()).toBe(0);
        expect(d.getUTCMinutes()).toBe(0);
        expect(d.getUTCSeconds()).toBe(0);
        expect(d.getUTCMilliseconds()).toBe(0);
      }
    });

    it("rolls over the year boundary correctly", () => {
      vi.setSystemTime(new Date("2026-01-31T12:00:00Z"));
      expect(monthStartUtc(2).toISOString()).toBe("2025-11-01T00:00:00.000Z");
    });

    it("monthEndUtc(n) is the last day of the same month as monthStartUtc(n)", () => {
      for (const frozen of ["2026-08-31T12:00:00Z", "2026-05-31T12:00:00Z"]) {
        vi.setSystemTime(new Date(frozen));
        for (let n = 1; n <= 6; n++) {
          const end = monthEndUtc(n);
          const dayAfterEnd = new Date(end.getTime() + 24 * 60 * 60 * 1000);
          expect(dayAfterEnd.toISOString()).toBe(monthStartUtc(n - 1).toISOString());
        }
      }
    });

    it("monthEndUtc(n) equals the existing SAFE end-derivation idiom", () => {
      for (const frozen of ["2026-08-31T12:00:00Z", "2026-05-31T12:00:00Z"]) {
        vi.setSystemTime(new Date(frozen));
        for (let n = 1; n <= 6; n++) {
          const d = new Date(monthStartUtc(n));
          d.setUTCMonth(d.getUTCMonth() + 1);
          d.setUTCDate(0);
          expect(monthEndUtc(n).toISOString()).toBe(d.toISOString());
        }
      }
    });

    it("live clock: monthStartUtc(0) is the 1st of the current tenant-TZ month, monthStartUtc(1) is strictly earlier", () => {
      const start0 = monthStartUtc(0);
      const start1 = monthStartUtc(1);
      expect(start0.getUTCDate()).toBe(1);
      expect(start1.getTime()).toBeLessThan(start0.getTime());
      expect(start0.toISOString()).not.toBe(start1.toISOString());
    });
  });

  // Issue #241: three month-lock gates (Berufsschultag create/delete, Schicht
  // wiederherstellen) compared SaldoSnapshot.periodStart against a naive
  // Date.UTC(year, month, 1) instead of the real monthRangeUtc() conversion the
  // monthly closer writes with — the gate silently never fired for 236 of 237
  // real rows. saldoSnapshotPeriodBounds is the shared fixture helper that closes
  // that gap in tests: it MUST delegate to monthRangeUtc, never re-derive it.
  describe("saldoSnapshotPeriodBounds", () => {
    it("delegates to monthRangeUtc for the calendar month containing `d` (UTC components)", () => {
      const d = new Date(Date.UTC(2026, 5, 15)); // 2026-06-15
      const bounds = saldoSnapshotPeriodBounds(d);
      const expected = monthRangeUtc(2026, 6, TEST_TZ);
      expect(bounds.start.toISOString()).toBe(expected.start.toISOString());
      expect(bounds.end.toISOString()).toBe(expected.end.toISOString());
    });

    it("pins the exact issue #241 regression: Europe/Berlin June 2026 start falls on the LAST DAY OF MAY, not June 1", () => {
      const d = new Date(Date.UTC(2026, 5, 15)); // 2026-06-15
      const { start } = saldoSnapshotPeriodBounds(d, "Europe/Berlin");
      // Naive comparison (the bug): new Date(Date.UTC(2026, 5, 1)) === "2026-06-01T00:00:00.000Z".
      // Real comparison (the fix): tenant-local midnight of June 1st, converted to UTC.
      expect(start.toISOString()).toBe("2026-05-31T22:00:00.000Z");
      expect(start.toISOString()).not.toBe(new Date(Date.UTC(2026, 5, 1)).toISOString());
    });

    it("accepts an explicit tz override independent of TEST_TZ", () => {
      const d = new Date(Date.UTC(2026, 0, 15)); // 2026-01-15, UTC tz → no offset
      const bounds = saldoSnapshotPeriodBounds(d, "UTC");
      expect(bounds.start.toISOString()).toBe("2026-01-01T00:00:00.000Z");
    });
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

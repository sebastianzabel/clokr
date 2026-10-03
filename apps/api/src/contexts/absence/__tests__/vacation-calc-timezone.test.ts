/**
 * Issue #450 (D-10, owner decision P4, #447 WR-02) — proves the § 5 BUrlG family no longer
 * depends on the server process timezone. Every input date is constructed in UTC
 * (`Date.UTC`/`utcMidnight`); the whole suite runs inside a process whose `TZ` is set to
 * `America/New_York` (a NEGATIVE UTC offset, unlike the documented UTC/Europe/Berlin
 * deployment) so that any remaining local-accessor read in the family would disagree with the
 * UTC-frame expectations below.
 *
 * Pure — no DB, no Fastify. `beforeAll`/`afterAll` save and restore `process.env.TZ` so the
 * change cannot leak into any other test file: vitest 4 runs each test file in its own forked
 * process (no `pool` override in `apps/api/vitest.config.ts`), so this is a belt-and-suspenders
 * restore rather than a cross-file necessity.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import {
  calculateProRataVacationForHire,
  wartezeitEndDate,
  fullEmploymentMonthsInYear,
  employmentMonthIndicesInYear,
  isFullEntitlementYear,
  hireYearVacationDays,
  employmentYearVacationDays,
  computeRegularVacationDays,
  computeRegularVacationDaysBySegments,
  statutoryMinimumVacationThreshold,
  type VacationContractSegment,
} from "../vacation-calc";
import { utcMidnight } from "../../../__tests__/test-dates";

const ORIGINAL_TZ = process.env.TZ;

beforeAll(() => {
  process.env.TZ = "America/New_York";
});

afterAll(() => {
  if (ORIGINAL_TZ === undefined) {
    delete process.env.TZ;
  } else {
    process.env.TZ = ORIGINAL_TZ;
  }
});

describe("§ 5 BUrlG family under a non-UTC process timezone (Issue #450, D-10)", () => {
  it("anti-vacuity: the TZ switch actually took effect (fails the file otherwise)", () => {
    // UTC midnight of 1 July 2027 read through LOCAL accessors in America/New_York (a negative
    // UTC offset) lands on 30 June — proof the process really is running in that zone, not
    // silently still in UTC.
    expect(new Date(Date.UTC(2027, 6, 1)).getDate()).toBe(30);
    expect(new Date(Date.UTC(2027, 6, 1)).getTimezoneOffset()).toBeGreaterThan(0);
  });

  describe("wartezeitEndDate", () => {
    it("01.01.2027 -> 30.06.2027 (UTC midnight)", () => {
      expect(wartezeitEndDate(utcMidnight("2027-01-01"))).toEqual(new Date(Date.UTC(2027, 5, 30)));
    });
    it("31.08.2027 -> 29.02.2028 (leap year, no numerically matching day)", () => {
      expect(wartezeitEndDate(utcMidnight("2027-08-31"))).toEqual(new Date(Date.UTC(2028, 1, 29)));
    });
    it("31.08.2026 -> 28.02.2027 (non-leap year, no numerically matching day)", () => {
      expect(wartezeitEndDate(utcMidnight("2026-08-31"))).toEqual(new Date(Date.UTC(2027, 1, 28)));
    });
  });

  describe("fullEmploymentMonthsInYear", () => {
    it("(2027, 01.02.2027, 30.06.2027) -> 5", () => {
      expect(
        fullEmploymentMonthsInYear(2027, utcMidnight("2027-02-01"), utcMidnight("2027-06-30")),
      ).toBe(5);
    });
    it("(2027, 02.07.2027, null) -> 6", () => {
      expect(fullEmploymentMonthsInYear(2027, utcMidnight("2027-07-02"), null)).toBe(6);
    });
    it("(2027, 2024-01-01, 01.01.2027) -> 0 (exit exactly on 1 Jan)", () => {
      expect(
        fullEmploymentMonthsInYear(2027, utcMidnight("2024-01-01"), utcMidnight("2027-01-01")),
      ).toBe(0);
    });
  });

  it("employmentMonthIndicesInYear(2027, 01.08.2027, null) -> [7, 8, 9, 10, 11]", () => {
    expect(employmentMonthIndicesInYear(2027, utcMidnight("2027-08-01"), null)).toEqual([
      7, 8, 9, 10, 11,
    ]);
  });

  describe("isFullEntitlementYear", () => {
    it("(2027, 01.07.2027, null) -> true (hire on the G9 cutoff)", () => {
      expect(isFullEntitlementYear(2027, utcMidnight("2027-07-01"), null)).toBe(true);
    });
    it("(2027, 02.07.2027, null) -> false (hire one day after the cutoff)", () => {
      expect(isFullEntitlementYear(2027, utcMidnight("2027-07-02"), null)).toBe(false);
    });
    it("(2027, 2020-01-01, 01.07.2027) -> true (exit in H2 after Wartezeit fulfilled)", () => {
      expect(
        isFullEntitlementYear(2027, utcMidnight("2020-01-01"), utcMidnight("2027-07-01")),
      ).toBe(true);
    });
    it("(2027, 2020-01-01, 30.06.2027) -> false (exit in H1)", () => {
      expect(
        isFullEntitlementYear(2027, utcMidnight("2020-01-01"), utcMidnight("2027-06-30")),
      ).toBe(false);
    });
  });

  describe("hireYearVacationDays", () => {
    it("base 20, hire 01.07.2027 -> 20 (on/before the G9 cutoff)", () => {
      expect(hireYearVacationDays(20, 2027, utcMidnight("2027-07-01"))).toBe(20);
    });
    it("base 20, hire 02.07.2027 -> 10", () => {
      expect(hireYearVacationDays(20, 2027, utcMidnight("2027-07-02"))).toBe(10);
    });
  });

  describe("calculateProRataVacationForHire", () => {
    it("base 30, year 2026, hire 31.12.2026 -> 3 (1/12, 2.5 rounds UP)", () => {
      expect(calculateProRataVacationForHire(30, 2026, utcMidnight("2026-12-31"))).toBe(3);
    });
    it("base 24, year 2026, hire 31.01.2026 -> 24 (January counts in full)", () => {
      expect(calculateProRataVacationForHire(24, 2026, utcMidnight("2026-01-31"))).toBe(24);
    });
    it("base 24, year 2026, hire 01.02.2026 -> 22 (January no longer counts)", () => {
      expect(calculateProRataVacationForHire(24, 2026, utcMidnight("2026-02-01"))).toBe(22);
    });
  });

  describe("employmentYearVacationDays", () => {
    it("base 24, hire 01.02.2027, exit 30.06.2027 -> 10", () => {
      expect(
        employmentYearVacationDays(24, 2027, utcMidnight("2027-02-01"), utcMidnight("2027-06-30")),
      ).toBe(10);
    });
    it("base 30, hire 2024-01-01, exit 01.07.2027 -> 30 (H2, full)", () => {
      expect(
        employmentYearVacationDays(30, 2027, utcMidnight("2024-01-01"), utcMidnight("2027-07-01")),
      ).toBe(30);
    });
  });

  it("computeRegularVacationDays: hire 01.10.2027 (after the G9 cutoff), base 30, 5-day week -> 8", () => {
    expect(
      computeRegularVacationDays({
        year: 2027,
        hireDate: utcMidnight("2027-10-01"),
        birthDate: null,
        exitDate: null,
        workDaysPerWeek: 5,
        baseDays: 30,
      }),
    ).toBe(8);
  });

  describe("computeRegularVacationDaysBySegments", () => {
    it("golden (issue): base 30, hire 2020-01-01, 3->5 days from 01.07.2027 -> 24", () => {
      const segments: VacationContractSegment[] = [
        { from: utcMidnight("2020-01-01"), workDaysPerWeek: 3 },
        { from: utcMidnight("2027-07-01"), workDaysPerWeek: 5 },
      ];
      expect(
        computeRegularVacationDaysBySegments({
          year: 2027,
          hireDate: utcMidnight("2020-01-01"),
          birthDate: null,
          exitDate: null,
          baseDays: 30,
          segments,
        }),
      ).toBe(24);
    });

    it("base 30, hire 2027-08-01, 3->5 days from 01.10.2027 -> 11", () => {
      const segments: VacationContractSegment[] = [
        { from: utcMidnight("2027-08-01"), workDaysPerWeek: 3 },
        { from: utcMidnight("2027-10-01"), workDaysPerWeek: 5 },
      ];
      expect(
        computeRegularVacationDaysBySegments({
          year: 2027,
          hireDate: utcMidnight("2027-08-01"),
          birthDate: null,
          exitDate: null,
          baseDays: 30,
          segments,
        }),
      ).toBe(11);
    });
  });

  it("statutoryMinimumVacationThreshold: hire 01.10.2027, 5-day week, base-derived 24/6*5=20 -> 5", () => {
    expect(
      statutoryMinimumVacationThreshold({
        birthDate: null,
        year: 2027,
        workDaysPerWeek: 5,
        hireDate: utcMidnight("2027-10-01"),
        exitDate: null,
      }),
    ).toBe(5);
  });
});

/**
 * karenz-overrun.test.ts
 *
 * Phase 104 (R4 / D-21 / D-22 / D-23 / D-24) — the § 5 EFZG Karenztage detector.
 *
 * Task 1: "find-karenz-overrun-days — detector" — Tests 1-9, the pure funnel's mechanics
 * plus the D-23 structural zero-import assertion. Monatsabschluss wiring (Task 2) and the
 * tenant config range (Task 3) are added to this file in later commits.
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  karenzOverrunFromRequests,
  normalizeKarenzDays,
  MAX_KARENZ_DAYS,
  type KarenzSickRow,
} from "../utils/find-karenz-overrun-days";

function sickRow(overrides: Partial<KarenzSickRow> = {}): KarenzSickRow {
  return {
    id: "sick-1",
    startDate: new Date("2026-06-01"),
    endDate: new Date("2026-06-05"),
    status: "APPROVED",
    attestPresent: false,
    attestValidFrom: null,
    attestValidTo: null,
    leaveType: { name: "Krankmeldung" },
    deletedAt: null,
    ...overrides,
  };
}

describe("find-karenz-overrun-days — detector", () => {
  it("Test 1: a 5-calendar-day sick period without an Attest and threshold 3 is an overrun", () => {
    const rows = [sickRow({ startDate: new Date("2026-06-01"), endDate: new Date("2026-06-05") })];
    const result = karenzOverrunFromRequests(rows, "Europe/Berlin", 3);
    expect(result).toHaveLength(1);
    expect(result[0].days).toEqual([
      "2026-06-01",
      "2026-06-02",
      "2026-06-03",
      "2026-06-04",
      "2026-06-05",
    ]);
  });

  it('Test 2: exactly 3 calendar days with threshold 3 is NOT an overrun ("länger als")', () => {
    const rows = [sickRow({ startDate: new Date("2026-06-01"), endDate: new Date("2026-06-03") })];
    const result = karenzOverrunFromRequests(rows, "Europe/Berlin", 3);
    expect(result).toHaveLength(0);
  });

  it("Test 3: counting is calendar days, not workdays — a Fri-Tue period is 5, not 3", () => {
    // 2026-06-05 is a Friday; 2026-06-09 is the following Tuesday. 5 calendar days
    // (Fri, Sat, Sun, Mon, Tue) even though the weekend is not worked.
    const rows = [sickRow({ startDate: new Date("2026-06-05"), endDate: new Date("2026-06-09") })];
    const result = karenzOverrunFromRequests(rows, "Europe/Berlin", 3);
    expect(result).toHaveLength(1);
    expect(result[0].days).toHaveLength(5);
  });

  it("Test 4: threshold 0 means every sick day needs an Attest", () => {
    const rows = [sickRow({ startDate: new Date("2026-06-01"), endDate: new Date("2026-06-01") })];
    const result = karenzOverrunFromRequests(rows, "Europe/Berlin", 0);
    expect(result).toHaveLength(1);
    expect(result[0].days).toEqual(["2026-06-01"]);
  });

  it("Test 5: a fully-attested period is never an overrun", () => {
    const rows = [
      sickRow({
        startDate: new Date("2026-06-01"),
        endDate: new Date("2026-06-05"),
        attestPresent: true,
        attestValidFrom: new Date("2026-06-01"),
        attestValidTo: new Date("2026-06-05"),
      }),
    ];
    const result = karenzOverrunFromRequests(rows, "Europe/Berlin", 3);
    expect(result).toHaveLength(0);
  });

  it("Test 6: a partial Attest narrower than the period reports only the uncovered days", () => {
    const rows = [
      sickRow({
        startDate: new Date("2026-06-01"),
        endDate: new Date("2026-06-05"),
        attestPresent: true,
        attestValidFrom: new Date("2026-06-04"),
        attestValidTo: new Date("2026-06-05"),
      }),
    ];
    const result = karenzOverrunFromRequests(rows, "Europe/Berlin", 3);
    expect(result).toHaveLength(1);
    expect(result[0].days).toEqual(["2026-06-01", "2026-06-02", "2026-06-03"]);
  });

  it("Test 7: non-sick leave types are never reported", () => {
    const rows = [
      sickRow({
        leaveType: { name: "Urlaub" },
        startDate: new Date("2026-06-01"),
        endDate: new Date("2026-06-10"),
      }),
    ];
    const result = karenzOverrunFromRequests(rows, "Europe/Berlin", 3);
    expect(result).toHaveLength(0);
  });

  it("Test 8: a legacy tenant value above 3 is clamped to 3 on read, not rejected", () => {
    expect(normalizeKarenzDays(30)).toBe(3);
    expect(normalizeKarenzDays(10)).toBe(3);
    expect(normalizeKarenzDays(3)).toBe(3);
    expect(normalizeKarenzDays(0)).toBe(0);
    expect(normalizeKarenzDays(-5)).toBe(0);
    expect(normalizeKarenzDays(null)).toBe(MAX_KARENZ_DAYS);
    expect(normalizeKarenzDays(undefined)).toBe(MAX_KARENZ_DAYS);

    // A 4-calendar-day period is an overrun under a legacy value of 30 ONLY if the module
    // clamps first — proves the clamp is actually exercised inside the detector, not just
    // in the standalone helper.
    const rows = [sickRow({ startDate: new Date("2026-06-01"), endDate: new Date("2026-06-04") })];
    const result = karenzOverrunFromRequests(rows, "Europe/Berlin", 30);
    expect(result).toHaveLength(1);
  });

  it("Test 9 (D-23 structural boundary): the module source contains no import statement", () => {
    const src = readFileSync(
      join(__dirname, "..", "utils", "find-karenz-overrun-days.ts"),
      "utf-8",
    );
    expect(/^\s*import\s/m.test(src)).toBe(false);
  });
});

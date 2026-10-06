/**
 * Issue #494 (D-01, D-09, D-10, D-11) — DB-free pins of the one track-only rule.
 *
 * - `isTrackOnlySchedule` matrix: schedule types x overtimeModes x monthlyHours values,
 *   including Prisma.Decimal, NaN, negative and non-numeric garbage.
 * - `isTrackOnlyZeroingLink` (D-11): only the by-design zeroing (stored carry 0) is exempt.
 * - `closeEmployeeMonth` pure cases: the shared close core zeroes the carry-over exactly for
 *   track-only contracts and leaves every other contract untouched (R2/R3).
 * - R4 static pin: the rule lives in `track-only-schedule.ts` and nowhere else — both production
 *   readers call it, no `overtimeMode === "TRACK_ONLY"` comparison remains in them.
 *
 * Numbers are hand-derived in the per-`it` comments. A disagreement between the hand derivation
 * and the code is a FINDING to report, never a reason to edit the number.
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { Prisma } from "@clokr/db";
import { isTrackOnlySchedule, isTrackOnlyZeroingLink } from "../track-only-schedule";
import { closeEmployeeMonth, type CloseMonthInput } from "../close-employee-month";
import { monthRangeUtc, monthDayBounds } from "../timezone";

const NO_TARGET_VALUES: Array<[string, unknown]> = [
  ["null", null],
  ["undefined", undefined],
  ["0", 0],
  ['"0"', "0"],
  ['"0.00"', "0.00"],
  ['Decimal("0.00")', new Prisma.Decimal("0.00")],
  ["-1", -1],
  ["NaN", Number.NaN],
  ['"abc"', "abc"],
];

const TARGET_VALUES: Array<[string, unknown]> = [
  ["0.5", 0.5],
  ["15", 15],
  ['"15"', "15"],
  ['Decimal("15.50")', new Prisma.Decimal("15.50")],
];

describe("isTrackOnlySchedule — Issue #494 matrix", () => {
  const modes: Array<unknown> = ["CARRY_FORWARD", "TRACK_ONLY", undefined];

  for (const mode of modes) {
    for (const [label, value] of NO_TARGET_VALUES) {
      it(`MONTHLY_HOURS ${String(mode)} with monthlyHours ${label} is track-only`, () => {
        expect(
          isTrackOnlySchedule({ type: "MONTHLY_HOURS", overtimeMode: mode, monthlyHours: value }),
        ).toBe(true);
      });
    }
  }

  for (const [label, value] of TARGET_VALUES) {
    it(`MONTHLY_HOURS CARRY_FORWARD with monthlyHours ${label} is NOT track-only`, () => {
      expect(
        isTrackOnlySchedule({
          type: "MONTHLY_HOURS",
          overtimeMode: "CARRY_FORWARD",
          monthlyHours: value,
        }),
      ).toBe(false);
    });
  }

  it("MONTHLY_HOURS TRACK_ONLY with monthlyHours 15 stays track-only (explicit mode wins)", () => {
    expect(
      isTrackOnlySchedule({ type: "MONTHLY_HOURS", overtimeMode: "TRACK_ONLY", monthlyHours: 15 }),
    ).toBe(true);
  });

  it("FIXED_SCHEDULE / FLEXTIME / SHIFT_BASED are never track-only, whatever monthlyHours or mode", () => {
    const all = [...NO_TARGET_VALUES, ...TARGET_VALUES];
    expect(all.length).toBeGreaterThan(10); // anti-vacuity: the loop below really runs
    for (const type of ["FIXED_SCHEDULE", "FLEXTIME", "SHIFT_BASED"]) {
      for (const mode of ["CARRY_FORWARD", "TRACK_ONLY", undefined]) {
        for (const [, value] of all) {
          expect(isTrackOnlySchedule({ type, overtimeMode: mode, monthlyHours: value })).toBe(
            false,
          );
        }
      }
    }
  });

  it("null / undefined schedule is not track-only", () => {
    expect(isTrackOnlySchedule(null)).toBe(false);
    expect(isTrackOnlySchedule(undefined)).toBe(false);
  });
});

describe("isTrackOnlyZeroingLink — D-11", () => {
  const trackOnly = { type: "MONTHLY_HOURS", overtimeMode: "CARRY_FORWARD", monthlyHours: null };
  const regular = { type: "MONTHLY_HOURS", overtimeMode: "CARRY_FORWARD", monthlyHours: 15 };

  it("track-only schedule + stored carry 0 is the by-design zeroing", () => {
    expect(isTrackOnlyZeroingLink({ storedCarryOver: 0 }, trackOnly)).toBe(true);
  });

  it("track-only schedule + non-zero stored carry (600 / -600) stays visible", () => {
    expect(isTrackOnlyZeroingLink({ storedCarryOver: 600 }, trackOnly)).toBe(false);
    expect(isTrackOnlyZeroingLink({ storedCarryOver: -600 }, trackOnly)).toBe(false);
  });

  it("non-track-only schedule + stored carry 0 is not exempt", () => {
    expect(isTrackOnlyZeroingLink({ storedCarryOver: 0 }, regular)).toBe(false);
  });
});

// ── closeEmployeeMonth pure cases (June 2026 shell mirrored from the #433 matrix) ────────────

const TZ = "Europe/Berlin";

function juneInput(schedule: Record<string, unknown>): CloseMonthInput {
  const { start: monthStart, end: monthEnd } = monthRangeUtc(2026, 6, TZ);
  const { firstDay: monthFirstDay, lastDay: monthLastDay } = monthDayBounds(
    monthStart,
    monthEnd,
    TZ,
  );
  return {
    employeeId: "emp-1",
    monthStart,
    monthEnd,
    monthFirstDay,
    monthLastDay,
    tz: TZ,
    carryOverIn: 300,
    schedule,
    hireDate: new Date("2025-01-01T00:00:00Z"),
    exitDate: null,
    isTimeTrackingExempt: false,
    breakOver6hOverride: 0,
    breakOver9hOverride: 0,
    // one 300-minute entry (5 h, below the 6 h break threshold)
    entries: [
      {
        date: new Date("2026-06-01T00:00:00Z"),
        startTime: new Date("2026-06-01T08:00:00Z"),
        endTime: new Date("2026-06-01T13:00:00Z"),
        breakMinutes: 0,
      },
    ],
    shifts: [],
    approvedLeave: [],
    absences: [],
    holidayDateStrings: new Set<string>(),
    tenantConfig: {
      defaultBreakOver6h: 30,
      defaultBreakOver9h: 45,
      defaultWorkDays: [1, 2, 3, 4, 5],
    },
  };
}

const MH_BASE = {
  type: "MONTHLY_HOURS",
  mondayHours: 0,
  tuesdayHours: 0,
  wednesdayHours: 0,
  thursdayHours: 0,
  fridayHours: 0,
  saturdayHours: 0,
  sundayHours: 0,
  workDays: [1, 2, 3, 4, 5],
};

describe("closeEmployeeMonth — track-only zeroing (Issue #494)", () => {
  for (const monthlyHours of [null, 0]) {
    for (const overtimeMode of ["CARRY_FORWARD", "TRACK_ONLY"]) {
      it(`monthlyHours ${String(monthlyHours)} ${overtimeMode}: carryOverOut 600, effective 0`, () => {
        // Hand derivation: no monthly hours → no Soll (0); worked 300; balance 300;
        // carryOverIn 300 + 300 = 600 before zeroing; track-only → effective carry 0.
        const result = closeEmployeeMonth(juneInput({ ...MH_BASE, monthlyHours, overtimeMode }));
        expect(result.carryOverOut).toBe(600);
        expect(result.effectiveCarryOverOut).toBe(0);
      });
    }
  }

  it("R2: monthlyHours 15 CARRY_FORWARD keeps its carry-over (effective === carryOverOut)", () => {
    const result = closeEmployeeMonth(
      juneInput({ ...MH_BASE, monthlyHours: 15, overtimeMode: "CARRY_FORWARD" }),
    );
    expect(result.effectiveCarryOverOut).toBe(result.carryOverOut);
    expect(result.carryOverOut).not.toBe(0); // anti-vacuity: the zeroing could not be hiding here
  });

  it("R3: FIXED_SCHEDULE with monthlyHours null CARRY_FORWARD keeps its carry-over", () => {
    const result = closeEmployeeMonth(
      juneInput({
        type: "FIXED_SCHEDULE",
        monthlyHours: null,
        overtimeMode: "CARRY_FORWARD",
        mondayHours: 8,
        tuesdayHours: 8,
        wednesdayHours: 8,
        thursdayHours: 8,
        fridayHours: 8,
        saturdayHours: 0,
        sundayHours: 0,
        workDays: [1, 2, 3, 4, 5],
      }),
    );
    expect(result.effectiveCarryOverOut).toBe(result.carryOverOut);
    expect(result.carryOverOut).not.toBe(0);
  });
});

// ── R4 static pin: the rule lives in exactly one file ────────────────────────────────────────

function read(file: string): string {
  const src = readFileSync(join(__dirname, "..", file), "utf8");
  expect(src.length).toBeGreaterThan(1000); // anti-vacuity: the file was really read
  return src;
}

describe("R4 — one place for the track-only rule (Issue #494)", () => {
  const readers = ["overtime-balance.ts", "close-employee-month.ts"];

  for (const file of readers) {
    it(`${file} imports and calls isTrackOnlySchedule, with no inline TRACK_ONLY comparison`, () => {
      const src = read(file);
      expect(src).toContain('from "./track-only-schedule"');
      expect(src).toContain("isTrackOnlySchedule(");
      expect(src).not.toMatch(/overtimeMode\s*===\s*"TRACK_ONLY"/);
    });
  }

  it("overtime-balance.ts resets the live loop on the month's own contract", () => {
    expect(read("overtime-balance.ts")).toContain("isTrackOnlySchedule(monthSchedule)");
  });

  it("saldo-chain-integrity.ts only re-exports the rule", () => {
    const src = read("saldo-chain-integrity.ts");
    expect(src).toContain('from "./track-only-schedule"');
    expect(src).not.toContain("export function isTrackOnlySchedule");
  });
});

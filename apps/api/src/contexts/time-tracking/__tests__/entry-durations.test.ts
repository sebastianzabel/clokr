/**
 * Phase 79 (Issue #79), D-11 — R1/R2 on the duration kernel, imported through the public
 * context surface exactly as every other context does. DB-free; every instant is a fixed past
 * instant, nothing is relative to "now".
 */
import { describe, it, expect } from "vitest";
import { entryDurations, addWorkingMinutes } from "..";

const d = (iso: string) => new Date(iso);

describe("entryDurations (R1/R2)", () => {
  it("08:00-16:00 with a 30 min break: presence 480 (8h), working 450 (7.5h)", () => {
    const r = entryDurations({
      startTime: d("2026-02-02T08:00:00.000Z"),
      endTime: d("2026-02-02T16:00:00.000Z"),
      breakMinutes: 30,
    });
    expect(r.presenceMinutes).toBe(480);
    expect(r.workingMinutes).toBe(450);
    expect(r.breakMinutes).toBe(30);
    expect(r.presenceMinutes / 60).toBe(8);
    expect(r.workingMinutes / 60).toBe(7.5);
  });

  it("an open entry yields presence 0 and working 0, the stored break stays a fact", () => {
    const r = entryDurations({
      startTime: d("2026-02-02T08:00:00.000Z"),
      endTime: null,
      breakMinutes: 30,
    });
    expect(r).toEqual({ presenceMinutes: 0, workingMinutes: 0, breakMinutes: 30 });
  });

  it("null and missing breakMinutes count as 0", () => {
    const base = {
      startTime: d("2026-02-02T08:00:00.000Z"),
      endTime: d("2026-02-02T16:00:00.000Z"),
    };
    expect(entryDurations({ ...base, breakMinutes: null }).workingMinutes).toBe(480);
    expect(entryDurations(base).workingMinutes).toBe(480);
    expect(entryDurations(base).breakMinutes).toBe(0);
  });

  it("a bigint break gives the identical result to the number", () => {
    const base = {
      startTime: d("2026-02-02T08:00:00.000Z"),
      endTime: d("2026-02-02T16:00:00.000Z"),
    };
    expect(entryDurations({ ...base, breakMinutes: 30n })).toEqual(
      entryDurations({ ...base, breakMinutes: 30 }),
    );
  });

  it("D-02: no auto-break is re-applied at read time (9h, break 0 -> 540)", () => {
    const r = entryDurations({
      startTime: d("2026-02-02T08:00:00.000Z"),
      endTime: d("2026-02-02T17:00:00.000Z"),
      breakMinutes: 0,
    });
    expect(r.workingMinutes).toBe(540);
    expect(r.presenceMinutes).toBe(540);
  });

  it("a break larger than the presence is not clamped (60 min presence, 90 break -> -30)", () => {
    const r = entryDurations({
      startTime: d("2026-02-02T08:00:00.000Z"),
      endTime: d("2026-02-02T09:00:00.000Z"),
      breakMinutes: 90,
    });
    expect(r.workingMinutes).toBe(-30);
  });

  it("millisecond precision stays exact and unrounded", () => {
    const r = entryDurations({
      startTime: d("2026-02-02T06:58:17.123Z"),
      endTime: d("2026-02-02T15:31:44.987Z"),
      breakMinutes: 0,
    });
    expect(r.presenceMinutes).toBe(30807864 / 60000);
    expect(r.workingMinutes).toBe(30807864 / 60000);
  });
});

describe("addWorkingMinutes (D-12)", () => {
  it("returns the sum unchanged for an open entry", () => {
    expect(
      addWorkingMinutes(123.5, {
        startTime: d("2026-02-02T08:00:00.000Z"),
        endTime: null,
        breakMinutes: 30,
      }),
    ).toBe(123.5);
  });

  it("equals sum + presence - break evaluated left to right for a closed entry", () => {
    const e = {
      startTime: d("2026-02-02T08:00:00.000Z"),
      endTime: d("2026-02-02T16:00:00.000Z"),
      breakMinutes: 30,
    };
    expect(addWorkingMinutes(100, e)).toBe(100 + 480 - 30);
  });

  it("keeps the (sum + p) - b association where sum + (p - b) would differ", () => {
    // Deterministic scan over millisecond-precision instants for a pair where the two
    // associations disagree in the last bit.
    let found: { sum: number; e: Parameters<typeof addWorkingMinutes>[1] } | null = null;
    const base = Date.UTC(2026, 1, 2, 6, 58, 17, 123);
    outer: for (let i = 0; i < 400 && !found; i++) {
      for (let j = 0; j < 400; j++) {
        const start = new Date(base + i * 7919);
        const end = new Date(base + 6 * 3600_000 + i * 7919 + j * 104_729 + 987);
        const sum = (i + 1) * 1234.5678901;
        const p = (end.getTime() - start.getTime()) / 60000;
        if (sum + p - 17 !== sum + (p - 17)) {
          found = { sum, e: { startTime: start, endTime: end, breakMinutes: 17 } };
          break outer;
        }
      }
    }
    expect(found).not.toBeNull();
    const { sum, e } = found!;
    const p = (e.endTime!.getTime() - e.startTime.getTime()) / 60000;
    expect(addWorkingMinutes(sum, e)).toBe(sum + p - 17);
    expect(addWorkingMinutes(sum, e)).not.toBe(sum + (p - 17));
  });
});

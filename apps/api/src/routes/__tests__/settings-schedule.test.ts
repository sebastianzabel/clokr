import { describe, it, expect } from "vitest";
import { employeeScheduleSchema } from "../settings";

// Wave 0 RED tests for Phase 49.1-01 — Zod validation of updated employeeScheduleSchema
// These tests are written BEFORE the FLEXTIME branch is implemented (TDD RED state).
// They will fail until Task 4 updates the Zod schema.

describe("employeeScheduleSchema — FIXED_SCHEDULE + FLEXTIME enum validation", () => {
  it("Zod accepts FIXED_SCHEDULE enum value", () => {
    const result = employeeScheduleSchema.safeParse({
      type: "FIXED_SCHEDULE",
      mondayHours: 8,
      tuesdayHours: 8,
      wednesdayHours: 8,
      thursdayHours: 8,
      fridayHours: 8,
      saturdayHours: 0,
      sundayHours: 0,
    });
    expect(result.success).toBe(true);
  });

  it("Zod accepts FLEXTIME with valid coreStart/coreEnd/coreDays", () => {
    const result = employeeScheduleSchema.safeParse({
      type: "FLEXTIME",
      weeklyHours: 40,
      coreStart: "09:00",
      coreEnd: "15:00",
      coreDays: [1, 2, 3, 4, 5],
    });
    expect(result.success).toBe(true);
  });

  it("Zod rejects FLEXTIME with weeklyHours = 0", () => {
    const result = employeeScheduleSchema.safeParse({
      type: "FLEXTIME",
      weeklyHours: 0,
    });
    expect(result.success).toBe(false);
    if (!result.success) {
      const weeklyIssue = result.error.issues.find((i) => i.path[0] === "weeklyHours");
      expect(weeklyIssue).toBeDefined();
    }
  });

  it("Zod rejects coreDays containing -1", () => {
    const result = employeeScheduleSchema.safeParse({
      type: "FLEXTIME",
      weeklyHours: 40,
      coreDays: [-1, 1, 2],
    });
    expect(result.success).toBe(false);
  });

  it("Zod rejects coreDays containing 7", () => {
    const result = employeeScheduleSchema.safeParse({
      type: "FLEXTIME",
      weeklyHours: 40,
      coreDays: [1, 2, 7],
    });
    expect(result.success).toBe(false);
  });

  it("Zod rejects coreEnd <= coreStart when both provided", () => {
    const result = employeeScheduleSchema.safeParse({
      type: "FLEXTIME",
      weeklyHours: 40,
      coreStart: "15:00",
      coreEnd: "09:00",
    });
    expect(result.success).toBe(false);
    if (!result.success) {
      const coreEndIssue = result.error.issues.find((i) => i.path[0] === "coreEnd");
      expect(coreEndIssue).toBeDefined();
    }
  });

  it("Zod accepts FLEXTIME with empty coreStart/coreEnd/coreDays (Kernarbeitszeit is optional)", () => {
    const result = employeeScheduleSchema.safeParse({
      type: "FLEXTIME",
      weeklyHours: 40,
    });
    expect(result.success).toBe(true);
  });

  it("Zod rejects coreStart without coreEnd (half-null Kernzeit)", () => {
    const result = employeeScheduleSchema.safeParse({
      type: "FLEXTIME",
      weeklyHours: 40,
      coreStart: "09:00",
      // coreEnd intentionally absent
    });
    expect(result.success).toBe(false);
    if (!result.success) {
      const coreEndIssue = result.error.issues.find((i) => i.path[0] === "coreEnd");
      expect(coreEndIssue).toBeDefined();
      expect(coreEndIssue?.message).toContain("gemeinsam");
    }
  });

  it("Zod rejects coreEnd without coreStart (half-null Kernzeit)", () => {
    const result = employeeScheduleSchema.safeParse({
      type: "FLEXTIME",
      weeklyHours: 40,
      coreEnd: "15:00",
      // coreStart intentionally absent
    });
    expect(result.success).toBe(false);
    if (!result.success) {
      const coreEndIssue = result.error.issues.find((i) => i.path[0] === "coreEnd");
      expect(coreEndIssue).toBeDefined();
      expect(coreEndIssue?.message).toContain("gemeinsam");
    }
  });
});

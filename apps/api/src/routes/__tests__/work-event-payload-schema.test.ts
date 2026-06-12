// Phase 77 Plan 03 — Zod discriminated-union contract tests for WorkEvent.payload (WORKEVENT-V19-03).
//
// These tests describe the schema's external contract: which payload shapes parse,
// which ones fail, and how TypeScript narrows the resulting union after parse.
// Each test maps to a contract claim in 77-03-PLAN.md must_haves.truths.

import { describe, it, expect } from "vitest";
import { WorkEventType } from "@clokr/db";
import {
  workEventPayloadSchema,
  vocationalSchoolPayloadSchema,
} from "../work-event-payload-schema";

describe("workEventPayloadSchema — VOCATIONAL_SCHOOL variant", () => {
  it("accepts valid VOCATIONAL_SCHOOL payload with all optional fields", () => {
    const parsed = workEventPayloadSchema.parse({
      type: WorkEventType.VOCATIONAL_SCHOOL,
      ordinalInWeek: 1,
      isBlockWeek: false,
      capWeekly: 2400,
    });
    expect(parsed.type).toBe(WorkEventType.VOCATIONAL_SCHOOL);
    if (parsed.type === WorkEventType.VOCATIONAL_SCHOOL) {
      expect(parsed.ordinalInWeek).toBe(1);
      expect(parsed.isBlockWeek).toBe(false);
      expect(parsed.capWeekly).toBe(2400);
    }
  });

  it("accepts minimal VOCATIONAL_SCHOOL payload (only discriminator)", () => {
    const parsed = workEventPayloadSchema.parse({ type: WorkEventType.VOCATIONAL_SCHOOL });
    expect(parsed.type).toBe(WorkEventType.VOCATIONAL_SCHOOL);
  });

  it("rejects VOCATIONAL_SCHOOL with ordinalInWeek out of range (> 3)", () => {
    const result = workEventPayloadSchema.safeParse({
      type: WorkEventType.VOCATIONAL_SCHOOL,
      ordinalInWeek: 4,
    });
    expect(result.success).toBe(false);
    if (!result.success) {
      const ordinalError = result.error.issues.find((i) => i.path.includes("ordinalInWeek"));
      expect(ordinalError).toBeDefined();
    }
  });

  it("rejects VOCATIONAL_SCHOOL with negative capWeekly", () => {
    const result = workEventPayloadSchema.safeParse({
      type: WorkEventType.VOCATIONAL_SCHOOL,
      capWeekly: -100,
    });
    expect(result.success).toBe(false);
    if (!result.success) {
      const capError = result.error.issues.find((i) => i.path.includes("capWeekly"));
      expect(capError).toBeDefined();
    }
  });
});

describe("workEventPayloadSchema — reserved-type passthrough variants", () => {
  it("accepts FIELD_SERVICE payload as permissive passthrough", () => {
    const parsed = workEventPayloadSchema.parse({
      type: "FIELD_SERVICE",
      destination: "Munich",
    });
    expect(parsed.type).toBe("FIELD_SERVICE");
  });

  it("accepts BUSINESS_TRIP payload as permissive passthrough", () => {
    const parsed = workEventPayloadSchema.parse({
      type: "BUSINESS_TRIP",
      randomField: 42,
    });
    expect(parsed.type).toBe("BUSINESS_TRIP");
  });

  it("accepts TRAINING payload as permissive passthrough", () => {
    const parsed = workEventPayloadSchema.parse({ type: "TRAINING" });
    expect(parsed.type).toBe("TRAINING");
  });

  it("accepts OTHER payload as permissive passthrough", () => {
    const parsed = workEventPayloadSchema.parse({
      type: "OTHER",
      anything: "goes",
    });
    expect(parsed.type).toBe("OTHER");
  });
});

describe("workEventPayloadSchema — discriminator validation", () => {
  it("rejects unknown discriminator value", () => {
    const result = workEventPayloadSchema.safeParse({ type: "UNKNOWN_TYPE" });
    expect(result.success).toBe(false);
    if (!result.success) {
      // Zod 4 emits `invalid_union` (with the discriminator path) for discriminated-union mismatches.
      const hasDiscriminatorIssue = result.error.issues.some(
        (i) => i.path.length === 0 || i.path.includes("type"),
      );
      expect(hasDiscriminatorIssue).toBe(true);
    }
  });

  it("rejects missing discriminator (no type field)", () => {
    const result = workEventPayloadSchema.safeParse({ ordinalInWeek: 1 });
    expect(result.success).toBe(false);
  });
});

describe("workEventPayloadSchema — TypeScript inference narrowing", () => {
  it("narrows VOCATIONAL_SCHOOL type to allow access to variant-specific fields", () => {
    // This test encodes a compile-time guarantee: after `.parse()`, narrowing on
    // `parsed.type === WorkEventType.VOCATIONAL_SCHOOL` exposes the variant-specific fields
    // without a TS error. If the discriminated-union is structured incorrectly,
    // this file would fail to compile.
    const parsed = workEventPayloadSchema.parse({
      type: WorkEventType.VOCATIONAL_SCHOOL,
      ordinalInWeek: 2,
      isBlockWeek: true,
      capWeekly: 1800,
    });

    if (parsed.type === WorkEventType.VOCATIONAL_SCHOOL) {
      // The cast below uses only the discriminated-union narrowed shape — no `as` cast.
      const ord: number | undefined = parsed.ordinalInWeek;
      const block: boolean | undefined = parsed.isBlockWeek;
      const cap: number | undefined = parsed.capWeekly;
      expect(ord).toBe(2);
      expect(block).toBe(true);
      expect(cap).toBe(1800);
    } else {
      throw new Error("Discriminator narrowing failed");
    }

    // Direct schema export is also usable on its own (Phase 79 may import the
    // variant directly when a route only accepts VOCATIONAL_SCHOOL).
    const directParsed = vocationalSchoolPayloadSchema.parse({
      type: WorkEventType.VOCATIONAL_SCHOOL,
      ordinalInWeek: 3,
    });
    expect(directParsed.ordinalInWeek).toBe(3);
  });
});

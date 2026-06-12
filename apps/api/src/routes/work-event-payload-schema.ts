// Phase 77 Plan 03 — Zod discriminated-union for WorkEvent.payload (WORKEVENT-V19-03).
//
// Why this exists: WorkEvent.payload is a Json @db.JsonB column. Zod validates the
// shape at the API boundary (Phase 79 endpoint bodies). The discriminated union
// produces TypeScript inference downstream: after parsing, the payload's `type` field
// narrows to the variant-specific shape automatically.
//
// ── Extensions pattern (v1.10+ adds new WorkEvent types) ──────────────────────
//
// Adding a new strict-typed variant is a pure DATA addition — no other file changes
// needed. Step-by-step:
//
//   1. Tighten the corresponding stub schema (e.g. fieldServicePayloadSchema) by
//      replacing .passthrough() with explicit field definitions:
//      ```
//      export const fieldServicePayloadSchema = z.object({
//        type: z.literal("FIELD_SERVICE"),
//        destination: z.string().min(1).max(200),
//        expensesNote: z.string().optional(),
//      });
//      ```
//   2. Re-run `pnpm --filter @clokr/api exec tsc --noEmit` — any caller using
//      `WorkEventPayload` with the narrowed `type` discriminator gets the new fields
//      via inference. Backward-compat for already-stored rows lives in the previous
//      .passthrough() era (no breaking change — strictness lands at API boundary
//      going forward, not retroactively).
//   3. Add a new test in __tests__/work-event-payload-schema.test.ts asserting
//      valid and invalid shapes of the new payload (mirror VOCATIONAL_SCHOOL tests).
//
// Reserved-but-permissive types (STACK.md §Schema-Model-Strategy): keeping
// FIELD_SERVICE / BUSINESS_TRIP / TRAINING / OTHER as passthrough means Phase 80+
// can store WorkEvent rows of those types without a schema change (forward-compat).
// Strictness is added in v1.10 when the actual payload shape stabilizes per-type owner.

import { z } from "zod";

// ── VOCATIONAL_SCHOOL — v1.9 strict variant ────────────────────────────────────
// Fields map to BBiG §15 Abs. 2 Nr. 1/2/3 slot model (FEATURES.md L86-99):
//   ordinalInWeek 1 = FIRST_LONG_DAY (Nr. 2, pauschal)
//   ordinalInWeek 2 = SECOND_LONG_DAY (Nr. 1, netto)
//   ordinalInWeek 3 = additional same-week slot (Nr. 1, netto)
//   isBlockWeek    = ≥25 UStd auf ≥5 Tagen (Nr. 3, pauschal weekly cap)
//   capWeekly      = block-week weekly cap in minutes (already-resolved by generator)
//
// All fields optional — the payload may be {} for legacy / unresolved rows.
// Phase 83 (BVaDiG 2024 conformance) tightens this further per the extensions pattern.
export const vocationalSchoolPayloadSchema = z.object({
  type: z.literal("VOCATIONAL_SCHOOL"),
  ordinalInWeek: z.number().int().min(1).max(3).optional(),
  isBlockWeek: z.boolean().optional(),
  capWeekly: z.number().int().min(0).optional(),
});

// ── Reserved types — permissive passthrough (forward-compat) ───────────────────
// Each schema accepts any extra fields (.passthrough()) so v1.10+ can store
// payload data without a Plan 77 schema change. Strict-shape upgrades happen
// per the extensions pattern at the top of this file.

export const fieldServicePayloadSchema = z
  .object({ type: z.literal("FIELD_SERVICE") })
  .passthrough();

export const businessTripPayloadSchema = z
  .object({ type: z.literal("BUSINESS_TRIP") })
  .passthrough();

export const trainingPayloadSchema = z.object({ type: z.literal("TRAINING") }).passthrough();

export const otherPayloadSchema = z.object({ type: z.literal("OTHER") }).passthrough();

// ── Top-level discriminated union ──────────────────────────────────────────────
// Phase 79 endpoint handlers call: workEventPayloadSchema.parse(req.body.payload).
// TypeScript narrows on the `type` field automatically downstream.
export const workEventPayloadSchema = z.discriminatedUnion("type", [
  vocationalSchoolPayloadSchema,
  fieldServicePayloadSchema,
  businessTripPayloadSchema,
  trainingPayloadSchema,
  otherPayloadSchema,
]);

export type WorkEventPayload = z.infer<typeof workEventPayloadSchema>;

/**
 * Issue #835 (D-835-01, A-10) — how a database refusal of a leave plan write is recognised. Pure:
 * no Prisma call, no clock.
 *
 * Recognition reads STRUCTURED fields only, never `err.message`: Prisma fills `message` with an
 * echo of the failed invocation including the argument values, so a substring search there can name
 * the wrong constraint (the lesson of `utils/prisma-unique-violation.ts`, Issue #567, and of
 * `contexts/time-tracking/entry-overlap-error.ts`, Issue #70, which this file is modelled on).
 *
 * Measured shape (Prisma 7.6 with `@prisma/adapter-pg`):
 *  - a second OPEN plan of a salon and year -> `P2002`, the index name `LeavePlan_open_unique` in
 *    `meta.driverAdapterError.cause.constraint.index` (read through `uniqueViolationTarget`).
 *  - two overlapping active wishes of one person -> `P2039` with `cause.originalCode` `"23P01"`
 *    (exclusion violation) and `cause.originalMessage` naming `LeavePlanWish_no_overlap_active`;
 *    `cause.constraint` is absent for a 23P01, so the constraint is named through `originalMessage`,
 *    which is the database's own text.
 *
 * Deliberately NOT re-exported from `contexts/absence/index.ts` (import-cycle cap 22).
 */
import { uniqueViolationTarget } from "../../../utils/prisma-unique-violation";

/** The partial unique index of one OPEN plan per salon and year (migration `*_leave_plan_checks`). */
const OPEN_PLAN_INDEX = "LeavePlan_open_unique";
/** The exclusion constraint of two active, not-taken-over wishes of one person (same migration). */
const WISH_OVERLAP_CONSTRAINT = "LeavePlanWish_no_overlap_active";

/** True when `err` is the database refusing a second OPEN plan of one salon and year. */
export function isOpenPlanUniqueViolation(err: unknown): boolean {
  const target = uniqueViolationTarget(err);
  return target !== null && target.includes(OPEN_PLAN_INDEX);
}

/** True when `err` is the database refusing an overlap of two active wishes of one person (23P01). */
export function isWishOverlapExclusion(err: unknown): boolean {
  if (err === null || typeof err !== "object") return false;
  if ((err as { code?: unknown }).code !== "P2039") return false;
  const meta = (err as { meta?: { driverAdapterError?: { cause?: Record<string, unknown> } } })
    .meta;
  const cause = meta?.driverAdapterError?.cause;
  if (cause?.originalCode !== "23P01") return false;
  const originalMessage = cause.originalMessage;
  return typeof originalMessage === "string" && originalMessage.includes(WISH_OVERLAP_CONSTRAINT);
}

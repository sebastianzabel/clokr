/**
 * Phase 100b Plan 01 (AC-1/AC-2, D-06) — Abwesenheiten's public surface.
 *
 * What is exported here is this context's public surface — ADR 0001 rule 3 (no direct table
 * access across foreign schemas; access only through the owning context's public interface) is
 * why this file exists at all. Anything NOT exported here is
 * module-internal and may change at any time without notice — a caller outside this context that
 * needs a new question answered gets a new named export, never a reach-around import of an
 * internal module.
 *
 * The implementation lives in `./facade/` (added wave by wave from plan 100B-10 onward) — that is
 * where a new facade function goes, not here. This file is a PURE re-export surface and contains
 * no Prisma call: it deliberately sits outside `SCOPED_DIRS`
 * (`apps/api/scripts/lint-tenant-scoping-types.ts`), and only `./facade/**` is walked by plan
 * 100B-04's tenant-gate extension. A query placed directly in this file would be invisible to
 * that gate — do not "helpfully" move one here.
 *
 * D-02: a facade function expresses the QUESTION a caller asks, not the caller's `where`. Two
 * callers with the same question share one function; a caller with a special case does not get a
 * function with a passed-through `where`.
 *
 * D-07: every facade function's first parameter is `db: Prisma.TransactionClient`, never
 * `app: FastifyInstance` — `hasApprovedLeaveOnDate` below already has this shape
 * (`leave-check.ts:10`, parameter named `prisma`) and is already called both with `app.prisma`
 * (`contexts/time-tracking/api/time-entries.ts:1095`) and with a `tx`
 * (`services/clock/resolver.ts:39`); it is the pattern every later facade function in this
 * context copies. `apps/api/scripts/lint-facade-signatures.ts` (plan 03) enforces this
 * mechanically.
 *
 * D-08: the soft-delete guard is NOT applied uniformly across this surface. Reading functions
 * carry `deletedAt: null` (as `hasApprovedLeaveOnDate` already does). The named compliance
 * functions this context will expose later (DSGVO Art. 17 anonymisation support, hard-delete
 * support, retention archival support) deliberately OMIT it and say so in their own docblock — a
 * blanket guard here would be an Art. 17 regression, not an improvement: a deleted employee's
 * leave rows must still be reachable for the anonymisation pass to null out their notes.
 *
 * Callers keep importing `../../absence/leave-check` directly for now — rewiring `time-entries.ts`
 * and `resolver.ts` to this index is wave 5's work (plan 100B-13), not this plan's. Two import
 * paths to the same function in the tree for no benefit is exactly what this plan avoids.
 */
export { hasApprovedLeaveOnDate } from "./leave-check";

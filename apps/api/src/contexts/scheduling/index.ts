/**
 * Phase 100b Plan 01 (AC-1/AC-2, D-06) — Schichtplanung's public surface.
 *
 * What is exported here is this context's public surface — ADR 0001 rule 3 (no direct table
 * access across foreign schemas; access only through the owning context's public interface) is
 * why this file exists at all. Anything NOT exported here is
 * module-internal and may change at any time without notice — a caller outside this context that
 * needs a new question answered gets a new named export, never a reach-around import of an
 * internal module.
 *
 * Filled as of wave 2, plan 100B-05: `Shift` and `EmployeeAvailability` now have exactly ONE
 * access path from outside this context — this file re-exports it. The implementation lives in
 * `./facade/`, never here directly: this file is a PURE re-export surface and must contain no
 * Prisma call, because it deliberately sits outside `SCOPED_DIRS`
 * (`apps/api/scripts/lint-tenant-scoping-types.ts`) — only `./facade/**` is walked by plan
 * 100B-04's tenant-gate extension, and a query placed directly here would be invisible to that
 * gate.
 *
 * D-02: a facade function expresses the QUESTION a caller asks, not the caller's `where`. Two
 * callers with the same question share one function; a caller with a special case does not get a
 * function with a passed-through `where`.
 *
 * D-07: every facade function's first parameter is `db: Prisma.TransactionClient`, never
 * `app: FastifyInstance` — `apps/api/scripts/lint-facade-signatures.ts` (plan 03) enforces this
 * mechanically.
 *
 * D-08: the soft-delete guard is NOT applied uniformly across a facade. Reading functions carry
 * `deletedAt: null`; the named compliance functions (DSGVO Art. 17 anonymisation, hard delete,
 * retention archival) deliberately omit it and say so in their own docblock — a blanket guard
 * would be a compliance regression, not an improvement.
 */
export {
  getShiftsInRange,
  flagShiftsConflictingWithLeave,
  cancelOrphanShifts,
} from "./facade/shifts";
export { getEmployeeAvailability } from "./facade/availability";

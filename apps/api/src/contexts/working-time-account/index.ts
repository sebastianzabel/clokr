/**
 * Phase 100b Plan 01 (AC-1/AC-2, D-06) — Arbeitszeitkonto's public surface.
 *
 * What is exported here is this context's public surface — ADR 0001 rule 3 (no direct table
 * access across foreign schemas; access only through the owning context's public interface) is
 * why this file exists at all. Anything NOT exported here is
 * module-internal and may change at any time without notice — a caller outside this context that
 * needs a new question answered gets a new named export, never a reach-around import of an
 * internal module.
 *
 * The implementation lives in `./facade/` (added wave by wave from plan 100B-06/07 onward) — that
 * is where a new facade function goes, not here. This file is a PURE re-export surface and
 * contains no Prisma call: it deliberately sits outside `SCOPED_DIRS`
 * (`apps/api/scripts/lint-tenant-scoping-types.ts`), and only `./facade/**` is walked by plan
 * 100B-04's tenant-gate extension. A query placed directly in this file would be invisible to
 * that gate — do not "helpfully" move one here.
 *
 * D-02: a facade function expresses the QUESTION a caller asks, not the caller's `where`. Two
 * callers with the same question share one function; a caller with a special case does not get a
 * function with a passed-through `where`.
 *
 * D-07: every facade function's first parameter is `db: Prisma.TransactionClient`, never
 * `app: FastifyInstance`. `apps/api/scripts/lint-facade-signatures.ts` (plan 03) enforces this
 * mechanically.
 *
 * D-08: the soft-delete guard is NOT applied uniformly across this surface. Reading functions
 * carry `deletedAt: null`; the named compliance functions this context exposes for DSGVO Art. 17
 * anonymisation, hard delete, and retention archival deliberately OMIT it and say so in their own
 * docblock — a blanket guard here would be an Art. 17 regression, not an improvement.
 *
 * TODO(100b-07): the `confirmed-saldo` re-exports below still take `app: FastifyInstance` as
 * their first parameter (`confirmed-saldo.ts:43,71`), not `db: Prisma.TransactionClient` — plan
 * 100B-07 changes that. Do NOT change the signature here; `confirmed-saldo.ts` already has
 * callers and that migration is plan 07's own work, not this plan's.
 *
 * Plan 100B-06 (Wave 3) adds the `OvertimeAccount`/`OvertimeTransaction` facade — W8–W15, all
 * `db: Prisma.TransactionClient`-first from day one (`./facade/overtime-account.ts`).
 */
export { getConfirmedCarryOver, getConfirmedCarryOverBulk } from "./confirmed-saldo";
export {
  getOvertimeAccount,
  listOvertimeAccountsForTenant,
  getBalances,
  bookOvertimeCompensation,
  reverseOvertimeCompensation,
  createOvertimeAccount,
  setOvertimeAccountBalance,
  hardDeleteOvertimeDataForEmployee,
} from "./facade/overtime-account";

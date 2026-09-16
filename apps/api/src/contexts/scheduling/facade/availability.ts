/**
 * Phase 100B Plan 05 (Wave 2) — Schichtplanung's `EmployeeAvailability`-model facade.
 *
 * S4 — the two `me.ts` sites (`:233` GET, `:277` the PUT handler's before-audit snapshot) both ask
 * the same question ("this employee's availability rows") and share one function; the GET adds an
 * `orderBy` the PUT snapshot doesn't need, which is R-C's INCIDENTAL case (both reads returned the
 * SAME set of rows either way, ordering has no bearing on the audit `oldValue` JSON the PUT site
 * builds from it) — applying the ordering uniformly is the same safe-default choice `getShiftsInRange`
 * makes for S1.
 *
 * Tenant: today, neither `me.ts:233` nor `:277` filters `employeeAvailability` by tenant at all —
 * both rely solely on `employeeId`. Both call sites tenant-validate `employeeId` immediately before
 * calling (`app.prisma.employee.findFirst({ where: { id: employeeId, tenantId: req.user.tenantId } })`,
 * `me.ts:210-217` for GET, `me.ts:255-260` for PUT) and 404 before this point if that check fails.
 * Adding `employee: { tenantId }` here is therefore the same proven-no-op class of change S2/S3
 * document, not a new risk — and it removes what would otherwise be a `*Id` parameter
 * (`lint-facade-signatures.ts` F3/G4) with a declared-but-unused `tenantId` sibling.
 * `employeeAvailability.findMany` is not itself a gate-relevant method
 * (`RELEVANT_METHODS`, `lint-tenant-scoping-types.ts`), so this is a defence-in-depth choice, not a
 * requirement the tenant-scoping gate's derivation depends on.
 */
import type { Prisma } from "@clokr/db";

export async function getEmployeeAvailability(
  db: Prisma.TransactionClient,
  employeeId: string,
  tenantId: string,
) {
  return db.employeeAvailability.findMany({
    where: { employeeId, employee: { tenantId } },
    orderBy: [{ date: "asc" }, { dayOfWeek: "asc" }],
  });
}

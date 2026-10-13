/**
 * Phase 89 (#89, D-12a) — Schichtplanung's `SalonCoupling` facade.
 *
 * SalonCoupling is owned by Schichtplanung. This module is the one place other contexts read it
 * through: the tenant routes and the operator's composition port call the same functions. It takes
 * already-resolved identifiers from its callers, imports no other context and writes no audit
 * entry — the caller audits (the operator writes `OperatorAuditLog`, a tenant route `AuditLog`).
 */
import type { Prisma } from "@clokr/db";

/** All coupling rows of a tenant, ordered deterministically (`salonId`, then `id`). */
export async function listSalonCouplings(db: Prisma.TransactionClient, tenantId: string) {
  return db.salonCoupling.findMany({
    where: { tenantId },
    orderBy: [{ salonId: "asc" }, { id: "asc" }],
  });
}

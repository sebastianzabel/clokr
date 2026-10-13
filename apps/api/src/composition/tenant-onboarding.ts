/**
 * Phase 88 (#88, orchestrator decision) — composition seam of the operator's tenant creation.
 *
 * `provisionTenantWithAdmin` (Unterbau) builds the tenant skeleton and its first admin, but the
 * Unterbau must not import the absence context. A freshly provisioned tenant still has to be
 * usable at once, and the admin's hire-year vacation entitlement needs the VACATION leave type, so
 * this module hands the Unterbau the one extra step through its `onTenantCreated` seam. It owns no
 * model and carries no rule: the default leave types are defined once in the absence context, and
 * the entitlement itself is written by the shared employee-creation code (`employee-creation.ts`
 * -> `ensureVacationEntitlementForYear`).
 */
import type { Prisma } from "@clokr/db";
import { ensureDefaultLeaveTypes } from "../contexts/absence";

/** Runs inside the operator's tenant-create transaction, before the first admin exists. */
export async function seedDefaultsForNewTenant(
  tx: Prisma.TransactionClient,
  tenantId: string,
): Promise<void> {
  await ensureDefaultLeaveTypes(tx, tenantId);
}

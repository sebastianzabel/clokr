/**
 * Phase 89 (#89, D-09/D-09a/D-09b) — the ONE place an operator-written row lands in a tenant's own
 * `AuditLog`.
 *
 * The operator acts on a customer tenant (first admin at tenant creation, salons and their
 * Phorest coupling afterwards). Two records exist for such an action: the operator's own
 * accountability row in `OperatorAuditLog` (`operator-audit.ts`) and the tenant's row here, so a
 * tenant admin reading the history of their own salons sees what the operator changed.
 *
 * Why `tenantId` is stamped into `newValue.actor`: an operator row has no `userId` (the operator
 * is no tenant user, and a tenant user's id is never used — nothing is written "as if a tenant
 * user did it"), and the tenant audit reader scopes through `user.employee.tenantId`. The stamp
 * is the only way for that reader to find a row without a user (D-09a). `tenantId` is therefore a
 * required input: no unstamped operator row can be written any more. Rows written before
 * Phase 89 carry no stamp and stay invisible to the tenant (append-only, not backfilled).
 *
 * Why callers use this writer directly and nothing is injected (D-09b): operator route files must
 * not call `.audit(` themselves, because that is where a forged or unstamped actor would slip in.
 * Route files name the result `writeTenantAudit`. A source guard
 * (`operator-tenant-audit-89.test.ts`) fails when any other non-test file spells the operator
 * actor shape. Details: ADR 0001 Eintrag Y, Nachtrag Phase 89.
 *
 * The writer honours the caller's transaction (`tx`), so the tenant row rolls back together with
 * the change it describes.
 */
import type { FastifyInstance } from "fastify";
import type { Prisma } from "@clokr/db";

type AuditRequestLike = {
  ip: string;
  headers: Record<string, string | string[] | undefined>;
};

export type OperatorTenantAuditEntry = {
  action: string;
  entity: string;
  entityId?: string;
  oldValue?: unknown;
  newValue?: object;
};

export type OperatorTenantAuditWriter = (
  entry: OperatorTenantAuditEntry,
  tx?: Prisma.TransactionClient,
) => Promise<void>;

/** Builds the writer for one operator acting on one tenant. */
export function operatorTenantAudit(
  app: FastifyInstance,
  input: { operatorId: string; tenantId: string; request?: AuditRequestLike },
): OperatorTenantAuditWriter {
  const actor = {
    type: "OPERATOR" as const,
    operatorId: input.operatorId,
    tenantId: input.tenantId,
  };
  return (entry, tx) =>
    app.audit({
      userId: undefined,
      action: entry.action,
      entity: entry.entity,
      entityId: entry.entityId,
      oldValue: entry.oldValue,
      newValue: { ...(entry.newValue ?? {}), actor },
      request: input.request,
      tx,
    });
}

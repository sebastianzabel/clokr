/**
 * Tenant deactivation instead of deletion (Phase 88, #88, AC-88-07/08, D-05).
 *
 * A tenant that leaves is never deleted: its time entries, leave, absences and employees are the
 * accountability record (see "Audit-Proof / Revisionssicherheit"). Deactivation sets three columns on
 * `Tenant` (`deactivatedAt`, `deactivatedReason`, `deactivatedByOperatorId`), revokes every open refresh
 * token of the tenant's users and writes an operator audit row — all in the CALLER's one transaction, so
 * the three effects commit or fail together. No row of the tenant's business data is touched.
 *
 * Which paths consult it:
 * - Credential paths (this plan): login (only after the password matched, so an unauthenticated caller
 *   learns nothing about tenant state), verify-otp, resend-otp, refresh, forgot-password, reset-password,
 *   change-password and invitation accept. Each answers `TENANT_DEACTIVATED_ERROR` (403), defined once here.
 * - The per-request check of already issued access tokens, API keys and device keys, and the operator
 *   route, follow in later plans of this phase; the cron rules (a deactivated tenant is skipped) arrive in 88-12.
 *
 * Users without an Employee have no tenant: a blank tenant id answers "not deactivated" on purpose
 * (D-10). That hole is #551 and is NOT changed here.
 */
import type { Prisma } from "@clokr/db";
import { OPERATOR_AUDIT_ACTIONS, recordOperatorAudit } from "./operator-audit";

/** The one spelling of "active tenant" for queries (`where: { …, ...ACTIVE_TENANT_WHERE }`). */
export const ACTIVE_TENANT_WHERE = { deactivatedAt: null } as const;

/**
 * The refusal body of every credential path. `code` is the control value; the German `error` text is
 * display only — nobody may branch on it.
 */
export const TENANT_DEACTIVATED_ERROR = {
  error: "Der Mandant ist deaktiviert. Eine Anmeldung ist nicht möglich.",
  code: "TENANT_DEACTIVATED",
} as const;

/** A missing row (user without Employee/tenant) counts as active — see the header on D-10. */
export function isTenantRowActive(row: { deactivatedAt: Date | null } | null | undefined): boolean {
  return !row || row.deactivatedAt === null;
}

/**
 * Whether the tenant is deactivated. A blank, whitespace or absent id and an unknown id answer
 * `false`; the blank case is answered without a query.
 */
export async function isTenantDeactivated(
  db: Pick<Prisma.TransactionClient, "tenant">,
  tenantId: string | null | undefined,
): Promise<boolean> {
  if (!tenantId || tenantId.trim() === "") return false;
  const row = await db.tenant.findUnique({
    where: { id: tenantId },
    select: { deactivatedAt: true },
  });
  return !isTenantRowActive(row);
}

type AuditRequestLike = {
  ip: string;
  headers: Record<string, string | string[] | undefined>;
};

export type DeactivateTenantResult =
  | {
      status: "OK";
      tenant: { id: string; deactivatedAt: Date; deactivatedReason: string | null };
      revokedRefreshTokens: number;
    }
  | { status: "NOT_FOUND" }
  | { status: "ALREADY_DEACTIVATED" };

/**
 * Deactivates a tenant inside the caller's transaction: columns, refresh-token revocation and the
 * `TENANT_DEACTIVATED` operator audit row. Refresh tokens carry no tenant column, so they are reached
 * through the user → employee → tenant relation.
 */
export async function deactivateTenant(
  tx: Prisma.TransactionClient,
  tenantId: string,
  input: { operatorId: string; reason: string; request?: AuditRequestLike },
): Promise<DeactivateTenantResult> {
  const current = await tx.tenant.findUnique({
    where: { id: tenantId },
    select: { id: true, deactivatedAt: true },
  });
  if (!current) return { status: "NOT_FOUND" };
  if (current.deactivatedAt) return { status: "ALREADY_DEACTIVATED" };

  const now = new Date();
  const tenant = await tx.tenant.update({
    where: { id: tenantId },
    data: {
      deactivatedAt: now,
      deactivatedReason: input.reason,
      deactivatedByOperatorId: input.operatorId,
    },
    select: { id: true, deactivatedAt: true, deactivatedReason: true },
  });

  const { count } = await tx.refreshToken.updateMany({
    where: { revokedAt: null, user: { employee: { tenantId } } },
    data: { revokedAt: now },
  });

  await recordOperatorAudit(tx, {
    action: OPERATOR_AUDIT_ACTIONS.TENANT_DEACTIVATED,
    operatorId: input.operatorId,
    subjectTenantId: tenantId,
    entity: "Tenant",
    entityId: tenantId,
    oldValue: { deactivatedAt: null },
    newValue: {
      deactivatedAt: now.toISOString(),
      reason: input.reason,
      revokedRefreshTokens: count,
    },
    request: input.request,
  });

  return {
    status: "OK",
    tenant: {
      id: tenant.id,
      deactivatedAt: tenant.deactivatedAt as Date,
      deactivatedReason: tenant.deactivatedReason,
    },
    revokedRefreshTokens: count,
  };
}

export type ReactivateTenantResult =
  | { status: "OK"; tenant: { id: string } }
  | { status: "NOT_FOUND" }
  | { status: "NOT_DEACTIVATED" };

/**
 * Reactivates a tenant inside the caller's transaction. Refresh tokens revoked by the deactivation stay
 * revoked: the users sign in again.
 */
export async function reactivateTenant(
  tx: Prisma.TransactionClient,
  tenantId: string,
  input: { operatorId: string; request?: AuditRequestLike },
): Promise<ReactivateTenantResult> {
  const current = await tx.tenant.findUnique({
    where: { id: tenantId },
    select: {
      id: true,
      deactivatedAt: true,
      deactivatedReason: true,
      deactivatedByOperatorId: true,
    },
  });
  if (!current) return { status: "NOT_FOUND" };
  if (!current.deactivatedAt) return { status: "NOT_DEACTIVATED" };

  await tx.tenant.update({
    where: { id: tenantId },
    data: { deactivatedAt: null, deactivatedReason: null, deactivatedByOperatorId: null },
  });

  await recordOperatorAudit(tx, {
    action: OPERATOR_AUDIT_ACTIONS.TENANT_REACTIVATED,
    operatorId: input.operatorId,
    subjectTenantId: tenantId,
    entity: "Tenant",
    entityId: tenantId,
    oldValue: {
      deactivatedAt: current.deactivatedAt.toISOString(),
      deactivatedReason: current.deactivatedReason,
      deactivatedByOperatorId: current.deactivatedByOperatorId,
    },
    newValue: { deactivatedAt: null },
    request: input.request,
  });

  return { status: "OK", tenant: { id: tenantId } };
}

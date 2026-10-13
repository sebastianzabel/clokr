/**
 * Operator audit trail (Phase 88, #88, D-07/D-07a).
 *
 * Every action of the operator principal (the account above the tenant) is written to
 * `OperatorAuditLog`, never to the tenant `AuditLog`:
 *   - `AuditLog.userId` is a foreign key onto `User`, and the tenant audit reader filters through
 *     `user.employee.tenantId` — an operator has neither, so its rows could not be carried or read there.
 *   - An operator action must never be written "as if a tenant user did it" (D-07, repudiation).
 *
 * This is the ONLY file allowed to name the `operatorAuditLog` delegate. The table is append-only on two
 * layers (D-07a): the writer below only creates rows, and the trigger migration
 * `*_operator_audit_log_append_only` refuses every UPDATE and TRUNCATE, and every DELETE except the
 * flagged retention purge of rows older than the 12-month floor. The trigger is accident- and
 * app-bug-proof, NOT insider-proof: the table owner can drop it.
 *
 * Callers pass their transaction client so the audit row and the audited action commit atomically.
 */

import type { Prisma } from "@clokr/db";

/** Every audited operator action. The names are control values; never match on display strings. */
export const OPERATOR_AUDIT_ACTIONS = {
  OPERATOR_CREATED: "OPERATOR_CREATED",
  OPERATOR_MFA_RESET: "OPERATOR_MFA_RESET",
  OPERATOR_DEACTIVATED: "OPERATOR_DEACTIVATED",
  OPERATOR_LOGIN: "OPERATOR_LOGIN",
  OPERATOR_LOGIN_FAILED: "OPERATOR_LOGIN_FAILED",
  OPERATOR_MFA_FAILED: "OPERATOR_MFA_FAILED",
  OPERATOR_LOCKED: "OPERATOR_LOCKED",
  OPERATOR_RECOVERY_CODE_USED: "OPERATOR_RECOVERY_CODE_USED",
  OPERATOR_PRINCIPAL_REFUSED: "OPERATOR_PRINCIPAL_REFUSED",
  TENANT_PRINCIPAL_REFUSED: "TENANT_PRINCIPAL_REFUSED",
  TENANT_CREATED: "TENANT_CREATED",
  TENANT_RENAMED: "TENANT_RENAMED",
  TENANT_DEACTIVATED: "TENANT_DEACTIVATED",
  TENANT_REACTIVATED: "TENANT_REACTIVATED",
  ADMIN_INVITATION_RESENT: "ADMIN_INVITATION_RESENT",
} as const;

export type OperatorAuditAction =
  (typeof OPERATOR_AUDIT_ACTIONS)[keyof typeof OPERATOR_AUDIT_ACTIONS];

export type OperatorAuditRetentionClass = "AUTH_EVENT" | "LIFECYCLE";

/**
 * Retention class per action — defined once, here. Authentication events are personal-data-heavy
 * (IP, user agent, failed attempts) and expire quickly; tenant/operator lifecycle actions are the
 * accountability record of what the operator did to customer data and follow the tenant default.
 */
export const OPERATOR_AUDIT_RETENTION_CLASS: Record<
  OperatorAuditAction,
  OperatorAuditRetentionClass
> = {
  OPERATOR_CREATED: "LIFECYCLE",
  OPERATOR_MFA_RESET: "LIFECYCLE",
  OPERATOR_DEACTIVATED: "LIFECYCLE",
  OPERATOR_LOGIN: "AUTH_EVENT",
  OPERATOR_LOGIN_FAILED: "AUTH_EVENT",
  OPERATOR_MFA_FAILED: "AUTH_EVENT",
  OPERATOR_LOCKED: "AUTH_EVENT",
  OPERATOR_RECOVERY_CODE_USED: "AUTH_EVENT",
  OPERATOR_PRINCIPAL_REFUSED: "AUTH_EVENT",
  TENANT_PRINCIPAL_REFUSED: "AUTH_EVENT",
  TENANT_CREATED: "LIFECYCLE",
  TENANT_RENAMED: "LIFECYCLE",
  TENANT_DEACTIVATED: "LIFECYCLE",
  TENANT_REACTIVATED: "LIFECYCLE",
  ADMIN_INVITATION_RESENT: "LIFECYCLE",
};

/**
 * Retention in months per class. AUTH_EVENT: 12 months (DSGVO Art. 5(1)(e) storage limitation — login
 * telemetry has no accountability value beyond a year). LIFECYCLE: 120 months, the tenant default
 * retention (10 years, § 147 AO), because these rows document operator access to customer tenants.
 * The 12-month figure is also the floor enforced by the database trigger for ANY delete.
 */
export const OPERATOR_AUDIT_RETENTION_MONTHS: Record<OperatorAuditRetentionClass, number> = {
  AUTH_EVENT: 12,
  LIFECYCLE: 120,
};

type AuditRequestLike = {
  ip: string;
  headers: Record<string, string | string[] | undefined>;
};

/** Client address and user agent of a request, in the shape of the audit columns. */
export function operatorAuditRequestFields(request?: AuditRequestLike): {
  ipAddress: string | undefined;
  userAgent: string | undefined;
} {
  const userAgent = request?.headers["user-agent"];
  return {
    ipAddress: request?.ip,
    userAgent: typeof userAgent === "string" ? userAgent : undefined,
  };
}

export type OperatorAuditEntry = {
  /** Acting operator; null/omitted for script actions and refused or unknown principals. */
  operatorId?: string | null;
  action: OperatorAuditAction;
  /** The tenant the action concerned — a plain string, deliberately not a foreign key. */
  subjectTenantId?: string | null;
  entity: string;
  entityId?: string | null;
  oldValue?: unknown;
  newValue?: unknown;
  request?: AuditRequestLike;
};

/** Create-only writer: the single legal way to add an operator audit row. */
export async function recordOperatorAudit(
  db: Prisma.TransactionClient,
  entry: OperatorAuditEntry,
): Promise<{ id: string }> {
  const { ipAddress, userAgent } = operatorAuditRequestFields(entry.request);
  return db.operatorAuditLog.create({
    data: {
      operatorId: entry.operatorId ?? undefined,
      action: entry.action,
      subjectTenantId: entry.subjectTenantId ?? undefined,
      entity: entry.entity,
      entityId: entry.entityId ?? undefined,
      oldValue: entry.oldValue ? JSON.parse(JSON.stringify(entry.oldValue)) : undefined,
      newValue: entry.newValue ? JSON.parse(JSON.stringify(entry.newValue)) : undefined,
      ipAddress,
      userAgent,
    },
    select: { id: true },
  });
}

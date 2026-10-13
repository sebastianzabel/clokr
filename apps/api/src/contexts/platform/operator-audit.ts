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
 *
 * Phase 89 (#89) adds the salon and coupling lifecycle of a customer tenant (create, update,
 * deactivate, activate, Phorest coupling set/removed), written by the operator salon routes. Each
 * of those actions is also written to the tenant's own AuditLog through `operator-tenant-audit.ts`.
 */

import type { Prisma, PrismaClient } from "@clokr/db";

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
  SALON_CREATED: "SALON_CREATED",
  SALON_UPDATED: "SALON_UPDATED",
  SALON_DEACTIVATED: "SALON_DEACTIVATED",
  SALON_ACTIVATED: "SALON_ACTIVATED",
  SALON_COUPLING_SET: "SALON_COUPLING_SET",
  SALON_COUPLING_REMOVED: "SALON_COUPLING_REMOVED",
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
  SALON_CREATED: "LIFECYCLE",
  SALON_UPDATED: "LIFECYCLE",
  SALON_DEACTIVATED: "LIFECYCLE",
  SALON_ACTIVATED: "LIFECYCLE",
  SALON_COUPLING_SET: "LIFECYCLE",
  SALON_COUPLING_REMOVED: "LIFECYCLE",
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

/** `months` UTC calendar months before `from` (day of month clamped to the target month's length). */
function subtractUtcMonths(from: Date, months: number): Date {
  const result = new Date(from.getTime());
  const day = result.getUTCDate();
  result.setUTCDate(1);
  result.setUTCMonth(result.getUTCMonth() - months);
  const lastDay = new Date(
    Date.UTC(result.getUTCFullYear(), result.getUTCMonth() + 1, 0),
  ).getUTCDate();
  result.setUTCDate(Math.min(day, lastDay));
  return result;
}

function actionsOfClass(retentionClass: OperatorAuditRetentionClass): string[] {
  return Object.values(OPERATOR_AUDIT_ACTIONS).filter(
    (action) => OPERATOR_AUDIT_RETENTION_CLASS[action] === retentionClass,
  );
}

/**
 * The only deletion path of OperatorAuditLog: removes rows whose retention class has expired at `now`.
 * Called by the data-retention job (wired in 88-12). The statement runs in a transaction that sets the
 * transaction-local flag `clokr.operator_audit_retention`, which the append-only trigger requires for any
 * DELETE; the trigger additionally refuses rows younger than 12 months, so even a misused flag cannot
 * erase recent events.
 */
export async function purgeExpiredOperatorAudit(
  db: PrismaClient,
  now: Date,
): Promise<{ deleted: number }> {
  return db.$transaction(async (tx) => {
    await tx.$executeRawUnsafe(`SET LOCAL clokr.operator_audit_retention = 'on'`);
    const { count } = await tx.operatorAuditLog.deleteMany({
      where: {
        OR: (Object.keys(OPERATOR_AUDIT_RETENTION_MONTHS) as OperatorAuditRetentionClass[]).map(
          (retentionClass) => ({
            action: { in: actionsOfClass(retentionClass) },
            createdAt: {
              lt: subtractUtcMonths(now, OPERATOR_AUDIT_RETENTION_MONTHS[retentionClass]),
            },
          }),
        ),
      },
    });
    return { deleted: count };
  });
}

// ── Bounded refusal audit ──────────────────────────────────────────────────

/** Length of the per-(principal, route) window in which repeated refusals collapse into one row. */
export const PRINCIPAL_REFUSAL_WINDOW_MS = 60_000;
const PRINCIPAL_REFUSAL_MAX_KEYS = 10_000;

type RefusalWindow = { windowStart: number; suppressed: number };
const refusalWindows = new Map<string, RefusalWindow>();

export type PrincipalRefusalEntry = {
  action: "TENANT_PRINCIPAL_REFUSED" | "OPERATOR_PRINCIPAL_REFUSED";
  /** The `sub` of the refused token — the key of the window together with the route. */
  principalSub: string;
  /**
   * The acting operator account, only for a refused token whose operator signature VERIFIED (the account
   * exists). Never set from an unverified claim: `operatorId` is a foreign key.
   */
  operatorId?: string | null;
  subjectTenantId?: string | null;
  route: string;
  method: string;
  request?: AuditRequestLike;
};

/**
 * Audit a cross-principal refusal (a tenant token on an operator route or the reverse) without letting
 * a token holder flood the append-only table: at most ONE row per (action, principal sub, route) per
 * 60-second window is written. Repeats inside the window only increment an in-process counter, and the
 * next row written for the key carries that count as `newValue.suppressedRepeats` — so the fact and the
 * number of attempts are never lost, only the row volume is bounded. The state is per process; with
 * several API replicas the bound is per replica, which is still a constant factor and not unbounded.
 * Expired windows without suppressed repeats are evicted on every call; one that still owes a count stays
 * until its key reappears. The map is capped (oldest first), the only case in which a count can be lost.
 */
export async function recordPrincipalRefusal(
  db: Prisma.TransactionClient,
  entry: PrincipalRefusalEntry,
  now: Date = new Date(),
): Promise<{ written: boolean }> {
  const nowMs = now.getTime();
  for (const [staleKey, window] of refusalWindows) {
    if (window.suppressed === 0 && nowMs - window.windowStart >= PRINCIPAL_REFUSAL_WINDOW_MS) {
      refusalWindows.delete(staleKey);
    }
  }

  const key = `${entry.action}|${entry.principalSub}|${entry.route}`;
  const previous = refusalWindows.get(key);
  if (previous && nowMs - previous.windowStart < PRINCIPAL_REFUSAL_WINDOW_MS) {
    previous.suppressed += 1;
    return { written: false };
  }

  const suppressedRepeats = previous?.suppressed ?? 0;
  // Re-insert so the key moves to the newest position of the insertion-ordered map.
  refusalWindows.delete(key);
  while (refusalWindows.size >= PRINCIPAL_REFUSAL_MAX_KEYS) {
    const oldest = refusalWindows.keys().next().value;
    if (oldest === undefined) break;
    refusalWindows.delete(oldest);
  }
  refusalWindows.set(key, { windowStart: nowMs, suppressed: 0 });

  await recordOperatorAudit(db, {
    operatorId: entry.operatorId ?? null,
    action: entry.action,
    subjectTenantId: entry.subjectTenantId,
    entity: "Route",
    entityId: entry.route,
    newValue: { principalSub: entry.principalSub, method: entry.method, suppressedRepeats },
    request: entry.request,
  });
  return { written: true };
}

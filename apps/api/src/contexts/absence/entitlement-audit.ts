/**
 * Issue #445 (D-06) — system-initiated `LeaveEntitlement` AuditLog rows.
 *
 * Automated corrections in `leave-days.ts` / `leave-self-heal.ts` (the ensure/heal wrapper, the
 * carry-over recalculation, the zero-placeholder read-time heal) have no `app` — they run inside
 * a `Prisma.TransactionClient` the caller already holds, or from a route handler that reaches
 * them without instantiating the `app.audit()` plugin's request-scoped context. This one helper
 * writes the AuditLog row directly through the db client the caller already has, `userId: null`
 * meaning "system" — the same convention `working-time-account/saldo-snapshot-cleanup.ts` and
 * `scripts/recalculate-shift-based-leave-days.ts` already use for an unattended correction.
 *
 * Keeping this as its own tiny file (rather than inlining `db.auditLog.create` at each of the
 * call sites in `leave-days.ts` / `leave-self-heal.ts`) means every existing deduct/reverse/
 * recalc signature, and the `RecalcDeps` shape scheduling/phorest build on top of, stays
 * unchanged — this is additive, not a rewire of those call sites' own parameters.
 */
import type { Prisma } from "@clokr/db";

export type EntitlementAuditEntry = {
  action: "CREATE" | "UPDATE";
  entityId: string;
  oldValue?: unknown;
  newValue?: unknown;
};

/**
 * Writes one system-initiated `LeaveEntitlement` AuditLog row (`userId: null`). Old/new values
 * are JSON round-tripped (`JSON.parse(JSON.stringify(v))`, `undefined` when absent) — the same
 * conversion `contexts/platform/plugins/audit.ts` applies to every audit write.
 */
export async function writeEntitlementAudit(
  db: Prisma.TransactionClient,
  entry: EntitlementAuditEntry,
): Promise<void> {
  await db.auditLog.create({
    data: {
      userId: null,
      action: entry.action,
      entity: "LeaveEntitlement",
      entityId: entry.entityId,
      oldValue:
        entry.oldValue !== undefined
          ? (JSON.parse(JSON.stringify(entry.oldValue)) as object)
          : undefined,
      newValue:
        entry.newValue !== undefined
          ? (JSON.parse(JSON.stringify(entry.newValue)) as object)
          : undefined,
    },
  });
}

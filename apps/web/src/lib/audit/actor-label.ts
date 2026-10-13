/**
 * Who a tenant audit row is shown as (Phase 89, D-09a/D-15).
 *
 * An operator-written row has no user; `operator-tenant-audit.ts` on the API side stamps
 * `newValue.actor` with the operator type code on it. The label is decided by that `type` code,
 * never by a display string. Pure module: no store, no `$app`.
 */

export type AuditActorLabel =
  | { kind: "user"; text: string }
  | { kind: "operator"; text: "Betreiber" }
  | { kind: "system"; text: "System" };

type AuditActorSource = {
  user: { email: string } | null;
  newValue: unknown;
};

function actorType(newValue: unknown): string | null {
  if (typeof newValue !== "object" || newValue === null) return null;
  const actor = (newValue as { actor?: unknown }).actor;
  if (typeof actor !== "object" || actor === null) return null;
  const type = (actor as { type?: unknown }).type;
  return typeof type === "string" ? type : null;
}

export function auditActorLabel(log: AuditActorSource): AuditActorLabel {
  if (log.user?.email) return { kind: "user", text: log.user.email };
  if (actorType(log.newValue) === "OPERATOR") return { kind: "operator", text: "Betreiber" };
  return { kind: "system", text: "System" };
}

/**
 * Phase 72b (Issue #72) — the permission catalog, Unterbau.
 *
 * Every permission Clokr knows is one atom spanned by three dimensions:
 * resource × action × reach. This module is the ONE machine-enumerable list of those atoms —
 * roles (#73) bundle them, the call-site switch (#75) checks them, the role UI (#83) displays
 * them. Nothing in this phase consults it at runtime yet; today's three fixed role levels stay
 * exactly as they are until #75 switches the call sites over.
 *
 * ── Why code and not a table ──────────────────────────────────────────────────────────────
 * The catalog changes only together with the code that checks it: a new permission is useless
 * until a route asks for it, and a route that asks for a permission the catalog does not know is
 * a bug. A database table could hold permissions no route knows about, and could be edited without
 * a deploy (owner decision on issue #72, 2026-09-24). Hence: no table, no migration, no Prisma
 * model — this module has no imports at all. `salon`, `role` and `role-assignment` are pure
 * catalog entries; they deliberately reference no model of those names (#64, #73, #74).
 *
 * ── Reach ─────────────────────────────────────────────────────────────────────────────────
 * - `EIGENE`: only the data of the signed-in employee themself.
 * - `ZUGEWIESEN`: all data within the scope of the role assignment (tenant, salons or a list of
 *   persons). The scope lives on the assignment (#74), NEVER in the catalog — the difference
 *   between a salon manager and an owner is their scope, not a different permission. There is
 *   no third reach value, and a test guards that.
 *
 * ── Relation ──────────────────────────────────────────────────────────────────────────────
 * - `PERSON`: the data belongs to one employee (time entries, requests, saldo, …). Both reach
 *   values are possible where "own data" makes sense for the action.
 * - `MANDANT`: tenant-wide configuration (SMTP, API keys, terminals, …). Such a resource carries
 *   `ZUGEWIESEN` only, and the permission takes effect only with an assignment scoped to the whole
 *   tenant — enforcement of that follows in #91.
 *
 * Contracts, saldo and month close are resources separate from time entries from the start: an
 * HR role needs contracts, saldo and absences without daily times (#76, DSGVO Art. 5 (1) c), and
 * once merged they could not be separated again.
 *
 * ── Deliberately NOT permissions ──────────────────────────────────────────────────────────
 * - The self-approval locks (leave review, retro entry requests), the rule that a leave
 *   cancellation is approved by a DIFFERENT manager, and the 4-eyes authorization of the
 *   post-retention hard delete. They hold for every role and must not be switchable by composing
 *   a role differently (#78). `employee:anonymize` grants the DSGVO deletion chain; the 4-eyes
 *   rule on top of it stays a lock.
 * - API-key scopes and terminal authentication stay outside the catalog; mapping API-key scopes
 *   onto permissions is #75.
 *
 * `docs/permissions.md` maps every current call site to one permission of this catalog and says,
 * in German, what each permission allows and what it explicitly does not.
 *
 * Keys are kebab-case exactly as in the issue #72 table; `context` is the code directory name of
 * the owning context (ADR 0001), `composition` for cross-context read models.
 */

/** The reach dimension — exactly two values (AK-72-3). */
export const PERMISSION_REACHES = ["EIGENE", "ZUGEWIESEN"] as const;
export type PermissionReach = (typeof PERMISSION_REACHES)[number];

/** Whose data a resource is: one employee's, or the tenant's. */
export const PERMISSION_RELATIONS = ["PERSON", "MANDANT"] as const;
export type PermissionRelation = (typeof PERMISSION_RELATIONS)[number];

/** The code directory of the owning context (`apps/api/src/contexts/<name>` or `composition`). */
type PermissionContext =
  | "platform"
  | "time-tracking"
  | "absence"
  | "working-time-account"
  | "scheduling"
  | "composition";

interface PermissionResourceDefinition {
  readonly context: PermissionContext;
  readonly relation: PermissionRelation;
}

export const PERMISSION_RESOURCES = {
  // ── Unterbau ──
  employee: { context: "platform", relation: "PERSON" },
  contract: { context: "platform", relation: "PERSON" },
  "tenant-settings": { context: "platform", relation: "MANDANT" },
  "api-key": { context: "platform", relation: "MANDANT" },
  "audit-log": { context: "platform", relation: "MANDANT" },
  holiday: { context: "platform", relation: "MANDANT" },
  salon: { context: "platform", relation: "MANDANT" },
  role: { context: "platform", relation: "MANDANT" },
  "role-assignment": { context: "platform", relation: "MANDANT" },
  // ── Zeiterfassung ──
  "time-entry": { context: "time-tracking", relation: "PERSON" },
  "retro-request": { context: "time-tracking", relation: "PERSON" },
  "presence-source": { context: "time-tracking", relation: "MANDANT" },
  terminal: { context: "time-tracking", relation: "MANDANT" },
  // ── Abwesenheiten ──
  "leave-request": { context: "absence", relation: "PERSON" },
  section9: { context: "absence", relation: "PERSON" },
  "leave-entitlement": { context: "absence", relation: "PERSON" },
  "leave-config": { context: "absence", relation: "MANDANT" },
  "company-shutdown": { context: "absence", relation: "MANDANT" },
  "vocational-school": { context: "absence", relation: "PERSON" },
  // ── Arbeitszeitkonto ──
  overtime: { context: "working-time-account", relation: "PERSON" },
  "month-close": { context: "working-time-account", relation: "PERSON" },
  // ── Scheduling ──
  shift: { context: "scheduling", relation: "PERSON" },
  "shift-config": { context: "scheduling", relation: "MANDANT" },
  "shift-pattern": { context: "scheduling", relation: "PERSON" },
  availability: { context: "scheduling", relation: "PERSON" },
  integration: { context: "scheduling", relation: "MANDANT" },
  // ── Composition ──
  report: { context: "composition", relation: "PERSON" },
  "team-overview": { context: "composition", relation: "PERSON" },
} as const satisfies Record<string, PermissionResourceDefinition>;

export type PermissionResource = keyof typeof PERMISSION_RESOURCES;

/** One permission — exactly one resource, one action, one reach (AK-72-2, AK-72-7). */
export interface Permission {
  readonly resource: PermissionResource;
  readonly action: string;
  readonly reach: PermissionReach;
}

/** `resource:action:REACH`, e.g. `time-entry:read:EIGENE`. */
export type PermissionKey = `${PermissionResource}:${string}:${PermissionReach}`;

/** The catalog: one flat entry per permission; EIGENE before ZUGEWIESEN for the same action. */
export const PERMISSIONS: readonly Permission[] = [
  // ── Unterbau ──
  { resource: "employee", action: "read", reach: "EIGENE" },
  { resource: "employee", action: "read", reach: "ZUGEWIESEN" },
  { resource: "employee", action: "create", reach: "ZUGEWIESEN" },
  { resource: "employee", action: "update", reach: "ZUGEWIESEN" },
  { resource: "employee", action: "manage-access", reach: "ZUGEWIESEN" },
  { resource: "employee", action: "anonymize", reach: "ZUGEWIESEN" },
  { resource: "employee", action: "import", reach: "ZUGEWIESEN" },
  { resource: "employee", action: "update-avatar", reach: "EIGENE" },
  { resource: "employee", action: "update-avatar", reach: "ZUGEWIESEN" },
  { resource: "contract", action: "read", reach: "EIGENE" },
  { resource: "contract", action: "read", reach: "ZUGEWIESEN" },
  { resource: "contract", action: "update", reach: "ZUGEWIESEN" },
  { resource: "tenant-settings", action: "read", reach: "ZUGEWIESEN" },
  { resource: "tenant-settings", action: "update", reach: "ZUGEWIESEN" },
  { resource: "api-key", action: "manage", reach: "ZUGEWIESEN" },
  { resource: "audit-log", action: "read", reach: "ZUGEWIESEN" },
  { resource: "holiday", action: "manage", reach: "ZUGEWIESEN" },
  { resource: "salon", action: "read", reach: "ZUGEWIESEN" },
  { resource: "salon", action: "manage", reach: "ZUGEWIESEN" },
  { resource: "role", action: "read", reach: "ZUGEWIESEN" },
  { resource: "role", action: "manage", reach: "ZUGEWIESEN" },
  { resource: "role-assignment", action: "manage", reach: "ZUGEWIESEN" },
  // ── Zeiterfassung ──
  { resource: "time-entry", action: "read", reach: "EIGENE" },
  { resource: "time-entry", action: "read", reach: "ZUGEWIESEN" },
  { resource: "time-entry", action: "create", reach: "EIGENE" },
  { resource: "time-entry", action: "create", reach: "ZUGEWIESEN" },
  { resource: "time-entry", action: "update", reach: "EIGENE" },
  { resource: "time-entry", action: "update", reach: "ZUGEWIESEN" },
  { resource: "time-entry", action: "delete", reach: "EIGENE" },
  { resource: "time-entry", action: "delete", reach: "ZUGEWIESEN" },
  { resource: "time-entry", action: "revalidate", reach: "ZUGEWIESEN" },
  { resource: "time-entry", action: "import", reach: "ZUGEWIESEN" },
  { resource: "retro-request", action: "read", reach: "EIGENE" },
  { resource: "retro-request", action: "read", reach: "ZUGEWIESEN" },
  { resource: "retro-request", action: "create", reach: "EIGENE" },
  { resource: "retro-request", action: "create", reach: "ZUGEWIESEN" },
  { resource: "retro-request", action: "approve", reach: "ZUGEWIESEN" },
  { resource: "presence-source", action: "manage", reach: "ZUGEWIESEN" },
  { resource: "terminal", action: "manage", reach: "ZUGEWIESEN" },
  // ── Abwesenheiten ──
  { resource: "leave-request", action: "read", reach: "EIGENE" },
  { resource: "leave-request", action: "read", reach: "ZUGEWIESEN" },
  { resource: "leave-request", action: "create", reach: "EIGENE" },
  { resource: "leave-request", action: "create", reach: "ZUGEWIESEN" },
  { resource: "leave-request", action: "approve", reach: "ZUGEWIESEN" },
  { resource: "leave-request", action: "correct", reach: "ZUGEWIESEN" },
  { resource: "leave-request", action: "attest", reach: "ZUGEWIESEN" },
  { resource: "leave-request", action: "cancel", reach: "EIGENE" },
  { resource: "leave-request", action: "cancel", reach: "ZUGEWIESEN" },
  { resource: "section9", action: "read", reach: "EIGENE" },
  { resource: "section9", action: "read", reach: "ZUGEWIESEN" },
  { resource: "section9", action: "upload", reach: "EIGENE" },
  { resource: "section9", action: "upload", reach: "ZUGEWIESEN" },
  { resource: "section9", action: "decide", reach: "ZUGEWIESEN" },
  { resource: "leave-entitlement", action: "read", reach: "EIGENE" },
  { resource: "leave-entitlement", action: "read", reach: "ZUGEWIESEN" },
  { resource: "leave-entitlement", action: "update", reach: "ZUGEWIESEN" },
  { resource: "leave-config", action: "read", reach: "ZUGEWIESEN" },
  { resource: "leave-config", action: "manage", reach: "ZUGEWIESEN" },
  { resource: "company-shutdown", action: "manage", reach: "ZUGEWIESEN" },
  { resource: "vocational-school", action: "read", reach: "EIGENE" },
  { resource: "vocational-school", action: "read", reach: "ZUGEWIESEN" },
  { resource: "vocational-school", action: "manage", reach: "ZUGEWIESEN" },
  // ── Arbeitszeitkonto ──
  { resource: "overtime", action: "read", reach: "EIGENE" },
  { resource: "overtime", action: "read", reach: "ZUGEWIESEN" },
  { resource: "overtime", action: "settle", reach: "ZUGEWIESEN" },
  { resource: "overtime", action: "set-opening-balance", reach: "ZUGEWIESEN" },
  { resource: "month-close", action: "read", reach: "ZUGEWIESEN" },
  { resource: "month-close", action: "close", reach: "ZUGEWIESEN" },
  { resource: "month-close", action: "unlock", reach: "ZUGEWIESEN" },
  { resource: "month-close", action: "close-year", reach: "ZUGEWIESEN" },
  // ── Scheduling ──
  { resource: "shift", action: "read", reach: "EIGENE" },
  { resource: "shift", action: "read", reach: "ZUGEWIESEN" },
  { resource: "shift", action: "plan", reach: "ZUGEWIESEN" },
  { resource: "shift-config", action: "manage", reach: "ZUGEWIESEN" },
  { resource: "shift-pattern", action: "read", reach: "EIGENE" },
  { resource: "shift-pattern", action: "read", reach: "ZUGEWIESEN" },
  { resource: "shift-pattern", action: "update", reach: "ZUGEWIESEN" },
  { resource: "availability", action: "read", reach: "EIGENE" },
  { resource: "availability", action: "read", reach: "ZUGEWIESEN" },
  { resource: "availability", action: "update", reach: "EIGENE" },
  { resource: "availability", action: "update", reach: "ZUGEWIESEN" },
  { resource: "integration", action: "manage", reach: "ZUGEWIESEN" },
  // ── Composition ──
  { resource: "report", action: "read", reach: "ZUGEWIESEN" },
  { resource: "report", action: "export", reach: "EIGENE" },
  { resource: "report", action: "export", reach: "ZUGEWIESEN" },
  { resource: "report", action: "notify", reach: "ZUGEWIESEN" },
  { resource: "team-overview", action: "read", reach: "ZUGEWIESEN" },
];

/** The stable string form of a permission: `resource:action:REACH`. */
export function permissionKey(p: Permission): PermissionKey {
  return `${p.resource}:${p.action}:${p.reach}`;
}

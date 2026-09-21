/**
 * Phase 100B Plan 10 (Wave 5, opening) — Abwesenheiten's `LeaveType` facade.
 *
 * ADR 0001 rule 3: every caller outside this context reaches `LeaveType` through one of the
 * functions below, never through `prisma.leaveType`/`tx.leaveType` directly. `LeaveType` is added
 * to `convertedModels` in `apps/api/scripts/foreign-context-access-exceptions.json` in the same
 * commit, so a future direct access is a hard error, not a slip that has to be re-discovered.
 *
 * D-07: every export's first parameter is `db: Prisma.TransactionClient` — `PrismaClient` is
 * assignable to it, so the SAME function runs whether the caller is inside a `$transaction` or
 * not. `apps/api/scripts/lint-facade-signatures.ts` enforces this mechanically (F1/F2).
 *
 * ── H1 — a display string as a control value, PRE-EXISTING, ONE of two sites closed here ───────
 * `LeaveType.name` is tenant-EDITABLE (CLAUDE.md § Context Boundaries: "never compare against
 * [a display name], never derive behaviour from it" — `leave-type.ts`'s own module header states
 * the same rule). Phase 100B Plan 10 identified two call sites violating it: `platform/api/
 * employees.ts`'s pro-rata-Urlaub exit warning (`leaveType.findFirst({ name: "Urlaub" })`) and
 * `time-tracking/plugins/attendance-checker.ts`'s § 7 BUrlG expiry reminder
 * (`leaveEntitlement.findMany({ leaveType: { name: "Urlaub" } })`) — filed as Issue #205.
 *
 * Issue #205 (Phase 205 Plan 01, finding 2) closes the pro-rata-exit site: its caller is rerouted
 * to `entitlements.ts`'s code-based {@link getLeaveTypeByCode} (via {@link getVacationEntitlement}).
 * The name-based `LeaveType` lookup that site alone depended on is deleted along with it — zero
 * remaining callers, verified by full-repo grep.
 *
 * The § 7 BUrlG reminder site is closed separately, by Phase 205 Plan 02
 * (`entitlements.ts`'s `getVacationEntitlementsForYearByDisplayName`, renamed in place there
 * rather than deleted, since no existing code-based function returns its tenant-wide, per-year,
 * `{employeeId, userId, firstName}` shape).
 *
 * ── H3 — {@link updateLeaveType} collapses a handler-level guard into a query-level proof ──────
 * `leave-settings.ts`'s `PUT /leave-types/:id` (moved from `platform/api/settings.ts` by Phase
 * 243 Plan 02 — B1; the URL is unchanged) used to run a tenant-scoped guard-fetch
 * (`findFirst({ id, tenantId })`) followed by an UNGUARDED `update({ id })` that relied on the
 * guard already having run. Both queries below carry `tenantId` in their OWN `where` — the second
 * query no longer depends on the first having executed correctly; it is independently safe. The
 * 404 for a missing OR foreign-tenant id is unchanged (both cases return `null` from the guard,
 * same as before).
 */
import type { LeaveType, LeaveTypeCode, Prisma } from "@clokr/db";

// ── A17 — the stable, code-based lookup ─────────────────────────────────────────────────────

/**
 * A17 — the `LeaveType` for `tenantId`/`code`, identified by the stable `@@unique([tenantId,
 * code])` key. This is THE lookup every new caller should use; see the module header for why the
 * two pre-existing name-based sites do not go through it.
 */
export async function getLeaveTypeByCode(
  db: Prisma.TransactionClient,
  tenantId: string,
  code: LeaveTypeCode,
): Promise<{ id: string; name: string } | null> {
  return db.leaveType.findUnique({
    where: { tenantId_code: { tenantId, code } },
    select: { id: true, name: true },
  });
}

// ── A18 — tenant-wide listing ────────────────────────────────────────────────────────────────

/**
 * A18 — every `LeaveType` for `tenantId`, ordered by display name. Sites: `leave-settings.ts`'s
 * `GET /leave-types` (full admin listing) and `scheduling/api/shifts.ts`'s roster read (which only
 * consumes `id`/`code` off the same rows — a wider `select` than one caller needs is not a `where`
 * divergence, so one function serves both; R-C's caution is about row-SET divergence, not
 * projection width).
 */
export async function listLeaveTypes(
  db: Prisma.TransactionClient,
  tenantId: string,
): Promise<LeaveType[]> {
  return db.leaveType.findMany({ where: { tenantId }, orderBy: { name: "asc" } });
}

// ── A19 — the update, H3 ─────────────────────────────────────────────────────────────────────

export interface UpdateLeaveTypeInput {
  allowHalfDay?: boolean;
  maxDaysPerYear?: number | null;
  leadTimeDays?: number | null;
  color?: string;
}

/**
 * A19 (H3) — the tenant-scoped guard-fetch AND the update, both carrying `tenantId` in their OWN
 * `where`. Returns `null` when `id` does not exist, or exists in a DIFFERENT tenant — the caller's
 * 404 is the same message either way, so this is not a membership oracle (unchanged from before
 * this plan). `existing` is returned alongside `updated` because the caller's audit log needs the
 * PRE-update `allowHalfDay`/`maxDaysPerYear` values.
 */
export async function updateLeaveType(
  db: Prisma.TransactionClient,
  tenantId: string,
  id: string,
  data: UpdateLeaveTypeInput,
): Promise<{ existing: LeaveType; updated: LeaveType } | null> {
  const existing = await db.leaveType.findFirst({ where: { id, tenantId } });
  if (!existing) return null;
  const updated = await db.leaveType.update({ where: { id, tenantId }, data });
  return { existing, updated };
}

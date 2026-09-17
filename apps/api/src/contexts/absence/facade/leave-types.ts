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
 * ── H1 — a display string as a control value, twice, PRE-EXISTING and NOT fixed here ──────────
 * `LeaveType.name` is tenant-EDITABLE (CLAUDE.md § Context Boundaries: "never compare against
 * [a display name], never derive behaviour from it" — `leave-type.ts`'s own module header states
 * the same rule). Two call sites this plan converts violate it today:
 * `platform/api/employees.ts`'s pro-rata-Urlaub exit warning (`leaveType.findFirst({ name:
 * "Urlaub" })`) and `time-tracking/plugins/attendance-checker.ts`'s § 7 BUrlG expiry reminder
 * (`leaveEntitlement.findMany({ leaveType: { name: "Urlaub" } })`). Renaming "Urlaub" in the admin
 * UI silently breaks both.
 *
 * D-13 forbids fixing a pre-existing deviation opportunistically inside a conversion plan. The
 * resolution here is NOT to prove code/name equivalence and route both sites through
 * {@link getLeaveTypeByCode}: this plan measured it against the dev database (one tenant, one
 * `LeaveType` row per code, `by_code_id === by_name_id`) and judged that measurement too thin to
 * stand on — a single-tenant sample proves nothing about a tenant that HAS renamed "Urlaub", which
 * is exactly the scenario the deviation exists to describe. Instead, {@link getLeaveTypeByCode}
 * (the stable, code-based lookup — the correct shape for every NEW caller) and
 * {@link getLeaveTypeByDisplayName} (the deviation, preserved verbatim, used ONLY by the two named
 * sites above via `entitlements.ts`'s `getVacationEntitlementByDisplayName` /
 * `getVacationEntitlementsForYearByDisplayName`) are two separate, explicitly named functions.
 * Filed as a GitHub issue linked to #100/#101 and `docs/adr/0001-abweichungen.md` § A.2 — see this
 * plan's SUMMARY for the issue number.
 *
 * ── H3 — {@link updateLeaveType} collapses a handler-level guard into a query-level proof ──────
 * `platform/api/settings.ts`'s `PUT /leave-types/:id` used to run a tenant-scoped guard-fetch
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

/**
 * H1 — the PRE-EXISTING display-name lookup, preserved verbatim. **Never call this for new code.**
 * `LeaveType.name` is tenant-editable; a tenant that renames "Urlaub" makes this return `null` for
 * a type that still exists under a different display name. Used only by
 * `entitlements.ts`'s `getVacationEntitlementByDisplayName` (the `platform/api/employees.ts`
 * pro-rata-exit site).
 */
export async function getLeaveTypeByDisplayName(
  db: Prisma.TransactionClient,
  tenantId: string,
  name: string,
): Promise<LeaveType | null> {
  return db.leaveType.findFirst({ where: { tenantId, name } });
}

// ── A18 — tenant-wide listing ────────────────────────────────────────────────────────────────

/**
 * A18 — every `LeaveType` for `tenantId`, ordered by display name. Sites: `settings.ts`'s
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

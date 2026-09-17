/**
 * Phase 100B Plan 10 (Wave 5, opening) — Abwesenheiten's `LeaveEntitlement` facade.
 *
 * ADR 0001 rule 3: every caller outside this context reaches `LeaveEntitlement` through one of the
 * functions below, never through `prisma.leaveEntitlement`/`tx.leaveEntitlement` directly.
 * `LeaveEntitlement` is added to `convertedModels` in
 * `apps/api/scripts/foreign-context-access-exceptions.json` in the same commit.
 *
 * D-07: every export's first parameter is `db: Prisma.TransactionClient`.
 *
 * These two models convert together (LeaveType + LeaveEntitlement, see this plan's own objective)
 * because every vacation-entitlement lookup resolves the VACATION `LeaveType` first and keys the
 * entitlement by `employeeId_leaveTypeId_year` — see {@link getVacationEntitlement}.
 *
 * ── A11/A16 vs the two `getVacationEntitlement*ByDisplayName` siblings ──────────────────────────
 * See `leave-types.ts`'s own module header (H1) for the full reasoning. In short:
 * {@link getVacationEntitlement} and {@link upsertVacationEntitlement} resolve the VACATION type
 * by its stable CODE (`leave-types.ts`'s `getLeaveTypeByCode`) — the correct shape, used by
 * `leave-settings.ts`'s GET/PUT `/vacation/:employeeId` (moved from `platform/api/settings.ts`
 * by Phase 243 Plan 02 — B1; the URL is unchanged). {@link
 * getVacationEntitlementByDisplayName} and {@link getVacationEntitlementsForYearByDisplayName}
 * preserve the two PRE-EXISTING name-based lookups verbatim (`platform/api/employees.ts`'s
 * pro-rata-exit warning, `time-tracking/plugins/attendance-checker.ts`'s § 7 BUrlG reminder) —
 * D-13, not fixed here, filed as an issue.
 *
 * ── A12 vs A13 vs A15 — three separately-named reads, not one parameterised query (R-B) ────────
 * {@link listEntitlementsForYear} (tenant-wide, by year), {@link getEntitlementsForEmployee}
 * (per-employee, by year) and {@link getExpiringCarryOver} (tenant-wide, by carry-over deadline
 * window) ask three different questions and stay three functions — implementing one in terms of
 * another is exactly the N+1 `confirmed-saldo.ts` warns its own callers about.
 *
 * ── T-100B-43 — {@link getEntitlementById} constrains on `tenantId` IN the query ────────────────
 * `composition/reports.ts`'s `POST /carryover-warn` used to run `findUnique({ where: { id } })`
 * and manually compare `ent.employee.tenantId !== req.user.tenantId` afterwards
 * (fetch-then-compare). The facade version below puts `employee: { tenantId }` directly in the
 * `findUnique`'s own `where` — a query-level proof instead of a caller-level one. The 404 for a
 * missing OR foreign-tenant id is unchanged (both return `null` here, same message at the route).
 *
 * ── H2 — {@link getExpiringCarryOver}'s `where` is BUrlG law, not a filter to simplify ─────────
 * `docs/burlg-carryover.md` is the rule (EuGH C-684/16 Hinweispflicht, the carry-over deadline
 * window). The `where` below is copied verbatim from `composition/reports.ts`'s pre-facade query,
 * not re-derived.
 */
import type { LeaveEntitlement, Prisma } from "@clokr/db";
import { getLeaveTypeByCode, getLeaveTypeByDisplayName } from "./leave-types";

// ── A11 — the vacation entitlement, resolved by code ────────────────────────────────────────

/**
 * A11 — resolves the VACATION `LeaveType` for `tenantId` (by code), then the entitlement keyed by
 * `employeeId_leaveTypeId_year`. Returns `null` when the tenant has no VACATION type configured
 * (the caller's existing "Urlaubstyp nicht konfiguriert" 404); otherwise `entitlement` is `null`
 * when none exists yet for `year` (the caller's existing "no entitlement row yet" branch).
 * Sites: `leave-settings.ts`'s GET and PUT `/vacation/:employeeId`.
 */
export async function getVacationEntitlement(
  db: Prisma.TransactionClient,
  employeeId: string,
  tenantId: string,
  year: number,
): Promise<{ leaveTypeId: string; entitlement: LeaveEntitlement | null } | null> {
  const vacationType = await getLeaveTypeByCode(db, tenantId, "VACATION");
  if (!vacationType) return null;
  const entitlement = await db.leaveEntitlement.findUnique({
    where: {
      employeeId_leaveTypeId_year: { employeeId, leaveTypeId: vacationType.id, year },
      employee: { tenantId },
    },
  });
  return { leaveTypeId: vacationType.id, entitlement };
}

// ── A12 — tenant-wide, by year ───────────────────────────────────────────────────────────────

/**
 * A12 — every `LeaveEntitlement` for `tenantId` in `year`, with `employee`/`leaveType` included.
 * Sites: `reports.ts`'s `GET /leave-overview`, `GET /vacation/pdf` and `GET /leave-overview/pdf` —
 * all three share the identical `where`; only their `employee` `select` width differs (some omit
 * `id`), which is a projection difference, not a row-set divergence, so one function serves all
 * three (R-C: read the real `where`, not just the shape of the call).
 */
export async function listEntitlementsForYear(
  db: Prisma.TransactionClient,
  tenantId: string,
  year: number,
) {
  return db.leaveEntitlement.findMany({
    where: { year, employee: { tenantId } },
    include: {
      employee: { select: { id: true, firstName: true, lastName: true, employeeNumber: true } },
      leaveType: true,
    },
  });
}

// ── A13 — per employee, by year ──────────────────────────────────────────────────────────────

/**
 * A13 — every `LeaveEntitlement` for `employeeId` in `year`. Site: `dashboard.ts`'s
 * "Resturlaub" card (`employeeId` there is the caller's OWN id, `req.user.employeeId`). The
 * pre-facade query carried no `tenantId` constraint at all; adding one here is a proven no-op
 * strengthening (an employee can only ever be their own tenant's), matching the pattern
 * `confirmed-saldo.ts`'s own widened functions use (100B-07-SUMMARY.md).
 */
export async function getEntitlementsForEmployee(
  db: Prisma.TransactionClient,
  employeeId: string,
  tenantId: string,
  year: number,
): Promise<LeaveEntitlement[]> {
  return db.leaveEntitlement.findMany({
    where: { employeeId, year, employee: { tenantId } },
  });
}

// ── A14 — by id, T-100B-43 ───────────────────────────────────────────────────────────────────

/**
 * A14 (T-100B-43) — the entitlement for `id`, constrained to `tenantId` IN the query. Site:
 * `reports.ts`'s `POST /carryover-warn`. See the module header for the fetch-then-compare ->
 * inline-relation-filter verdict change this replaces.
 */
export async function getEntitlementById(
  db: Prisma.TransactionClient,
  tenantId: string,
  id: string,
): Promise<LeaveEntitlement | null> {
  return db.leaveEntitlement.findUnique({ where: { id, employee: { tenantId } } });
}

// ── A15 — carry-over expiry, H2 ──────────────────────────────────────────────────────────────

/**
 * A15 (H2) — entitlements whose carry-over deadline falls in `(now, cutoff]` and still carry
 * non-zero `carriedOverDays`, for the BUrlG § 7 Hinweispflicht / EuGH C-684/16 "Verfall-Warnungen"
 * widget. `where` copied verbatim from `reports.ts`'s pre-facade `GET /carryover-at-risk` — see
 * `docs/burlg-carryover.md`, not re-derived here.
 */
export async function getExpiringCarryOver(
  db: Prisma.TransactionClient,
  tenantId: string,
  now: Date,
  cutoff: Date,
) {
  return db.leaveEntitlement.findMany({
    where: {
      employee: { tenantId, exitDate: null },
      carriedOverDays: { gt: 0 },
      carryOverDeadline: { gt: now, lte: cutoff },
    },
    include: {
      employee: { select: { id: true, firstName: true, lastName: true, employeeNumber: true } },
      leaveType: { select: { id: true, name: true } },
    },
  });
}

// ── A16 — the vacation upsert ─────────────────────────────────────────────────────────────────

export interface UpsertVacationEntitlementData {
  totalDays: number;
  carriedOverDays: number;
  carryOverDeadline: Date | null;
}

/**
 * A16 — resolves the VACATION `LeaveType` for `tenantId` (by code, same as A11), then upserts the
 * entitlement keyed by `employeeId_leaveTypeId_year`. Returns `null` in the (practically
 * unreachable, since the caller already ran A11 first in the same handler) case where the tenant
 * has no VACATION type configured. Site: `leave-settings.ts`'s `PUT /vacation/:employeeId`.
 */
export async function upsertVacationEntitlement(
  db: Prisma.TransactionClient,
  employeeId: string,
  tenantId: string,
  year: number,
  data: UpsertVacationEntitlementData,
): Promise<LeaveEntitlement | null> {
  const vacationType = await getLeaveTypeByCode(db, tenantId, "VACATION");
  if (!vacationType) return null;
  return db.leaveEntitlement.upsert({
    where: {
      employeeId_leaveTypeId_year: { employeeId, leaveTypeId: vacationType.id, year },
      employee: { tenantId },
    },
    update: data,
    create: { employeeId, leaveTypeId: vacationType.id, year, ...data },
  });
}

// ── H1 deviation-preserving siblings (leave-types.ts's getLeaveTypeByDisplayName) ───────────────

/**
 * H1 — preserves `platform/api/employees.ts`'s pro-rata-exit warning verbatim: resolve the
 * "Urlaub"-NAMED `LeaveType` (NOT by code — see `leave-types.ts`'s module header), then the
 * entitlement for `employeeId`/`year`. Returns `null` when no type is named "Urlaub" for this
 * tenant OR no entitlement row exists yet — both cases the caller already treats as "skip the
 * warning", so collapsing them here changes nothing observable.
 */
export async function getVacationEntitlementByDisplayName(
  db: Prisma.TransactionClient,
  employeeId: string,
  tenantId: string,
  year: number,
): Promise<LeaveEntitlement | null> {
  const vacationType = await getLeaveTypeByDisplayName(db, tenantId, "Urlaub");
  if (!vacationType) return null;
  return db.leaveEntitlement.findFirst({
    where: { employeeId, leaveTypeId: vacationType.id, year },
  });
}

/**
 * H1 — preserves `attendance-checker.ts`'s § 7 BUrlG expiry-reminder query verbatim: every
 * `LeaveEntitlement` for `tenantId` in `year` whose `LeaveType.name` (NOT code) is "Urlaub". See
 * `leave-types.ts`'s module header for why this stays name-based rather than being routed through
 * A12/A17.
 */
export async function getVacationEntitlementsForYearByDisplayName(
  db: Prisma.TransactionClient,
  tenantId: string,
  year: number,
) {
  return db.leaveEntitlement.findMany({
    where: {
      year,
      employee: { tenantId },
      leaveType: { name: "Urlaub" },
    },
    include: {
      employee: { select: { id: true, userId: true, firstName: true } },
    },
  });
}

// ── F3 — the hard-delete slice ────────────────────────────────────────────────────────────────

/**
 * F3 exception (D-08, no `tenantId` parameter — see `lint-facade-signatures-exceptions.json`): a
 * HARD delete of every `LeaveEntitlement` row for `employeeId`, invoked ONLY from
 * `platform/api/employees.ts`'s `DELETE /:id/hard-delete` sequence inside its own `$transaction`,
 * whose handler already validates `id` against `req.user.tenantId` before this function is ever
 * reached. No `deletedAt` guard — a hard delete must reach soft-deleted rows too.
 */
export async function hardDeleteEntitlementsForEmployee(
  db: Prisma.TransactionClient,
  employeeId: string,
): Promise<void> {
  await db.leaveEntitlement.deleteMany({ where: { employeeId } });
}

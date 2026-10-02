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
 * ── A11/A16 vs the remaining sibling below ───────────────────────────────────────────────────
 * See `leave-types.ts`'s own module header (H1) for the full reasoning. In short:
 * {@link getVacationEntitlement} and {@link upsertVacationEntitlement} resolve the VACATION type
 * by its stable CODE (`leave-types.ts`'s `getLeaveTypeByCode`) — the correct shape, used by
 * `leave-settings.ts`'s GET/PUT `/vacation/:employeeId` (moved from `platform/api/settings.ts`
 * by Phase 243 Plan 02 — B1; the URL is unchanged). `platform/api/employees.ts`'s pro-rata-exit
 * warning is rerouted to {@link getVacationEntitlement} as of Issue #205 (Phase 205 Plan 01,
 * finding 2) — its previous name-based facade function, and the display-name lookup it alone
 * depended on, are both deleted (zero remaining callers, verified by full-repo grep).
 * {@link getVacationEntitlementsForYearByCode} closes Issue #205's remaining finding 1
 * (`time-tracking/plugins/attendance-checker.ts`'s § 7 BUrlG reminder, Phase 205 Plan 02) — it was
 * renamed in place and its `where` now filters on `LeaveType.code`, not `LeaveType.name`, since no
 * existing code-based function returns its tenant-wide, per-year, `{employeeId, userId,
 * firstName}` shape.
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
import { getLeaveTypeByCode } from "./leave-types";
import { computeRegularVacationDays } from "../vacation-calc"; // Issue #445 (D-01) — the one regular-entitlement computation

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
  // Issue #416: optional so the pre-existing PUT /vacation/:employeeId call site (an explicit
  // admin write) stays byte-identical — omitting it leaves the column untouched on `update` and
  // falls back to the schema default (`false`) on `create`. Only ensureVacationEntitlementForYear
  // below sets it (to `true`, always).
  isAutoCalculated?: boolean;
  // Issue #445 (D-16): optional for the same reason — PUT /vacation/:employeeId is the only
  // writer of these two columns; omitting either leaves it untouched on `update` and falls back
  // to the schema default (`null`) on `create`.
  carryOverReason?: string | null;
  carryOverNote?: string | null;
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

// ── Issue #416 — ensureVacationEntitlementForYear (auto-seed on hire / first access / repair) ──

/**
 * Auto-seeding audit callback shape — the subset of `app.audit()`'s params this facade function
 * needs. Facade functions take `db: Prisma.TransactionClient` (D-07), never
 * `app: FastifyInstance`, so they cannot call `app.audit()` themselves; every caller passes its
 * own `app.audit`-backed closure (already bound to the same transaction client `db` runs on)
 * instead — see the three call sites below.
 */
export type EnsureVacationEntitlementAuditFn = (entry: {
  userId?: string;
  action: "CREATE";
  entity: "LeaveEntitlement";
  entityId: string;
  newValue: unknown;
}) => Promise<void>;

/**
 * Issue #416 — ensures a VACATION `LeaveEntitlement` row exists for `employeeId`/`year`.
 *
 * No-op-on-existing (returns the row unchanged, `created: false`) when a row already exists for
 * `(employeeId, VACATION leaveTypeId, year)` — this is what makes every caller (hire-time
 * creation, first-access self-heal, the repair script) structurally idempotent without
 * re-implementing the check three times. Do not remove it.
 *
 * When creating, `totalDays` is computed by {@link computeRegularVacationDays} (Issue #445,
 * D-01 — extracted verbatim from this function's own former inline formula): `baseDays` —
 * the caller's resolved output of `resolveVacationBaseDays()` (Issue #435, D-05/D-06: person
 * value ?? tenant default ?? 30 — never a raw `TenantConfig.defaultVacationDays` read) — scaled
 * by the employee's contractual workdays (owner decision, Issue #416: `baseDays` means "N days at
 * a 5-day-week workload" — the reference week is stated there because the data model has no
 * explicit reference-week field), floored at the § 19 JArbSchG / § 3 BUrlG statutory minimum for
 * `birthDate` (Issue #435, D-07/D-09 — the caller's resolved employee birth date, never derived
 * here), then, for `year === hireDate`'s year, further pro-rated for the hire year; every other
 * year (a later year, or the repair script's/first-access self-heal's "missing current-year row
 * for an already-employed active employee" case) gets the full floored amount unprorated, because
 * the employee was already employed at that year's start. Composition order (scale, THEN floor,
 * THEN pro-rate) is deliberate — see `computeRegularVacationDays`'s own docblock and
 * `416-CONTEXT.md`/`435-CONTEXT.md`.
 *
 * Returns `null` only in the practically-unreachable case where the tenant has no VACATION
 * `LeaveType` configured (mirrors {@link getVacationEntitlement} / {@link upsertVacationEntitlement}).
 *
 * Sites: `platform/api/employees.ts`'s `POST /employees` (hire-time), `leave-settings.ts`'s
 * `GET /vacation/:employeeId` (first access), `scripts/backfill-missing-vacation-entitlements.ts`
 * (repair script).
 */
export async function ensureVacationEntitlementForYear(
  db: Prisma.TransactionClient,
  employeeId: string,
  tenantId: string,
  year: number,
  hireDate: Date,
  birthDate: Date | null,
  exitDate: Date | null,
  workDaysPerWeek: number,
  baseDays: number,
  reason: string,
  auditFn: EnsureVacationEntitlementAuditFn,
): Promise<{ entitlement: LeaveEntitlement; created: boolean } | null> {
  const existing = await getVacationEntitlement(db, employeeId, tenantId, year);
  if (!existing) return null; // no VACATION LeaveType configured for this tenant
  if (existing.entitlement) return { entitlement: existing.entitlement, created: false };

  // Issue #445 (D-01): the regular-entitlement computation now lives in ONE place —
  // computeRegularVacationDays() in vacation-calc.ts — moved verbatim from here.
  // Issue #435 (D-06/D-09): callers pass the output of resolveVacationBaseDays() (person value ??
  // tenant default) as `baseDays`, and the employee's birth date for the statutory-minimum floor —
  // never a raw TenantConfig value. Issue #447 (D-05): `exitDate` is threaded through the same way,
  // so an employee who has already left owes the § 5 BUrlG Teilurlaub of the exit year, not the
  // full amount.
  const totalDays = computeRegularVacationDays({
    year,
    hireDate,
    birthDate,
    exitDate,
    workDaysPerWeek,
    baseDays,
  });

  let entitlement: LeaveEntitlement | null;
  try {
    entitlement = await upsertVacationEntitlement(db, employeeId, tenantId, year, {
      totalDays,
      carriedOverDays: 0,
      carryOverDeadline: null,
      isAutoCalculated: true,
    });
  } catch (err: unknown) {
    // Issue #416: `upsertVacationEntitlement`'s `where` combines the compound unique constraint
    // with an additional `employee: { tenantId }` relation filter, so Prisma cannot lower it to a
    // single atomic `INSERT ... ON CONFLICT DO UPDATE` — under two genuinely concurrent callers
    // that both observed "no row yet" above, one still raises P2002 here instead of silently
    // updating (same backstop pattern as services/clock/resolver.ts's ALREADY_CLOCKED_IN P2002
    // mapping, duck-typed the same way — this repo's established idiom, not a new one). The race
    // LOSER re-fetches the winner's row and treats it exactly like the `existing.entitlement`
    // branch above: no audit, `created: false`.
    if (typeof err === "object" && err !== null && "code" in err && err.code === "P2002") {
      const refetched = await getVacationEntitlement(db, employeeId, tenantId, year);
      return refetched?.entitlement ? { entitlement: refetched.entitlement, created: false } : null;
    }
    throw err;
  }
  if (!entitlement) return null; // same practically-unreachable case as above

  // Issue #416: the `existing` check above is a SELECT before the upsert, not atomic with it —
  // under two genuinely concurrent callers for the same (employeeId, year) that both observe no
  // row yet (e.g. two browser tabs loading /leave at once), BOTH would reach this point. The
  // underlying `@@unique([employeeId, leaveTypeId, year])` constraint still guarantees exactly one
  // row ever exists (Prisma's upsert is atomic at the DB level, INSERT ... ON CONFLICT DO UPDATE
  // on Postgres) — but without this check, both callers would unconditionally write a CREATE
  // audit entry for what is, for the loser of the race, actually an update. `createdAt` and
  // `updatedAt` are set to the same `now()` by the single INSERT statement that wins the race;
  // the loser's conflict branch only touches `updatedAt`, so comparing the two after the fact
  // reliably distinguishes "I created this row" from "someone else already had". Only the actual
  // creator audits CREATE; the race loser gets the row silently, exactly like `existing.entitlement`
  // above.
  const genuinelyCreated = entitlement.createdAt.getTime() === entitlement.updatedAt.getTime();
  if (genuinelyCreated) {
    await auditFn({
      action: "CREATE",
      entity: "LeaveEntitlement",
      entityId: entitlement.id,
      newValue: { totalDays, isAutoCalculated: true, reason },
    });
  }

  return { entitlement, created: genuinelyCreated };
}

// ── Vacation entitlements for a year, by code (Issue #205 finding 1, Phase 205 Plan 02) ────────

/**
 * Every `LeaveEntitlement` for `tenantId` in `year` whose `LeaveType.code` is `VACATION`. Site:
 * `time-tracking/plugins/attendance-checker.ts`'s § 7 BUrlG / EuGH C-684/16 expiry-reminder cron
 * (`checkVacationExpiry()`). This function previously resolved the VACATION type by its
 * tenant-editable display name; it is renamed in place here and its `where` changed from a
 * `LeaveType.name` filter to this `LeaveType.code` filter — a tenant that renames the VACATION
 * type no longer silently stops receiving the reminder. Return shape, tenant-wide scope and the
 * `employee: { id, userId, firstName }` projection are unchanged; no existing code-based function
 * (`listEntitlementsForYear`, A12) returns this exact shape — see `leave-types.ts`'s module header
 * (H1) for why A12 does not fit.
 */
export async function getVacationEntitlementsForYearByCode(
  db: Prisma.TransactionClient,
  tenantId: string,
  year: number,
) {
  return db.leaveEntitlement.findMany({
    where: {
      year,
      employee: { tenantId },
      leaveType: { code: "VACATION" },
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

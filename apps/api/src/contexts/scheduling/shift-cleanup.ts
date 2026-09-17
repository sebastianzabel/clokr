// Phase 67.2 Plan 04 — Shift-Auto-Cleanup on VOCATIONAL_SCHOOL Absence creation.
//
// Invoked from:
//   - utils/vocational-school-generator.ts (post-Absence-create batch, triggerSource="PATTERN")
//   - routes/vocational-school.ts POST /manual-insert (D-23) (post-create, triggerSource="MANUAL")
//
// Audit-Proof Guarantees (CLAUDE.md + Phase 47.2 + RESEARCH §148-156):
//   - NEVER hard-deletes a Shift row (only soft-delete via deletedAt + deletedReason).
//   - Past shifts (date <= today): ONLY conflictsWithLeave=true flag, NEVER delete
//     (Phase 47.2 SHIFT_PAST_IMMUTABLE invariant). Today counts as "past" because
//     in-day correction is the user's responsibility — we don't yank a shift mid-day.
//   - Future shifts (date > today): soft-delete (deletedAt=now, deletedReason=
//     "AUTO_BS_DAY_CLEANUP"). Plan 67.2-05 surfaces a restore UI.
//   - Locked-month shifts: skipped entirely (surfaces as `lockedSkipped` counter).
//     Past shifts are typically in locked months anyway, but the explicit guard
//     defends against the case where a manager flagged a month as closed early.
//   - Tenant opt-out via TenantConfig.vocationalSchoolAutoCleanupShifts (default true).
//   - Each mutation produces an AuditLog entry via app.audit() with the SYSTEM origin
//     marker (userId: undefined). Existing audit pattern from vocational-school-generator.ts.
//   - Idempotent: re-running with the same dates does not double-flag or re-soft-delete
//     (already-soft-deleted shifts are excluded by deletedAt: null filter; already-
//     flagged past shifts are counted but skip the audit write to suppress noise).

import type { PrismaClient } from "@clokr/db";
import type { FastifyInstance } from "fastify";
import {
  getClosedMonthsForDates, // Phase 100B Plan 07 — W2a
  getTenantTimezone,
  monthRangeUtc,
} from "../working-time-account"; // Phase 101B

// app.audit signature (see plugins/audit.ts) — kept loose to match the Fastify decorator type.
type AuditFn = FastifyInstance["audit"];

export interface ShiftCleanupResult {
  /** true when the tenant opted out via vocationalSchoolAutoCleanupShifts=false. */
  skipped: boolean;
  /** Count of future shifts (date > today) that were soft-deleted. */
  futureSoftDeleted: number;
  /** Count of past/today shifts that were flagged conflictsWithLeave=true (incl. already-flagged). */
  pastFlagged: number;
  /** Count of shifts skipped because their month was locked via SaldoSnapshot. */
  lockedSkipped: number;
  /** Ids of shifts that were touched OR already flagged — for caller-side batched notification. */
  affectedShiftIds: string[];
}

export interface ShiftCleanupParams {
  tenantId: string;
  employeeId: string;
  /** UTC date-only Dates (00:00:00.000Z) — produced by generator/manual-insert. */
  dates: Date[];
  /** Override "now" for testing. Defaults to new Date(). */
  now?: Date;
  /** Audit-trail context: did this fire from the cron Generator or a manual insert? */
  triggerSource: "PATTERN" | "MANUAL";
}

// ── Date helpers (module-private) ────────────────────────────────────────────

function dateOnlyUtc(d: Date): Date {
  return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()));
}

/**
 * The real `SaldoSnapshot.periodStart` for the calendar month containing `d`, in the
 * tenant timezone.
 *
 * Issue #241 (fifth site): this file used to have its own `monthStartUtc()`, structurally
 * identical to the naive helper removed from the three route-level sites in `8326859d` and
 * the auto-generator's own copy fixed in `840d9976` — `new Date(Date.UTC(year, month, 1))`,
 * compared directly against the STORED `periodStart` (`:122-128` built `monthStarts` from
 * this naive value and filtered `periodStart: { in: monthStarts }`; `:143` looked up with the
 * same naive value against a `Set` built from the STORED, `monthRangeUtc()`-written
 * `periodStart`). For a tenant ahead of UTC (Europe/Berlin) the real value falls on the LAST
 * DAY OF THE PREVIOUS month, so neither comparison could ever match — this automatic
 * (non-route, no-human-in-the-loop) cleanup soft-deleted shifts inside locked months. See the
 * generator's own `monthLockBoundUtc()` (`../absence/vocational-school-generator.ts`) for the
 * identical defect and fix shape; not shared as one exported helper on purpose — each caller
 * already has its own tenantId in scope and a second file importing a third module's private
 * helper is not an improvement over two one-line functions.
 */
function monthLockBoundUtc(d: Date, tz: string): Date {
  return monthRangeUtc(d.getUTCFullYear(), d.getUTCMonth() + 1, tz).start;
}

/**
 * "YYYY-MM-DD" of `d`'s UTC calendar date — used ONLY for the in-memory `lockedMonths` lookup
 * key below, never for the Prisma `where` fetch itself (that one compares the real `Date`
 * against the `@db.Date` column and is correct at the SQL level regardless of time-of-day).
 *
 * `periodStart` is `@db.Date` (see `packages/db/prisma/schema.prisma`): Postgres stores and
 * Prisma reads it back as UTC MIDNIGHT of its calendar date, discarding whatever time-of-day the
 * write carried. `monthLockBoundUtc()` above legitimately carries a REAL, non-midnight
 * time-of-day (e.g. `2030-05-31T22:00:00.000Z` for June/Europe-Berlin) — comparing its FULL
 * `.toISOString()` against a row read back from the DB (`2030-05-31T00:00:00.000Z`) can never
 * match even after the tenant-TZ fix, which is exactly what an earlier version of this fix
 * (caught by this file's own T5 test, RED against it) got wrong. Slicing to the calendar-date
 * component before comparing is what `vocational-school-generator.ts`'s own lockKey
 * (`toIsoDate()`) already does for the identical reason — mirrored here, not re-invented.
 */
function toIsoDate(d: Date): string {
  return d.toISOString().slice(0, 10);
}

// ── Public API ────────────────────────────────────────────────────────────────

export async function cleanupShiftsForBSAbsence(
  prisma: PrismaClient,
  audit: AuditFn,
  params: ShiftCleanupParams,
): Promise<ShiftCleanupResult> {
  const now = params.now ?? new Date();
  const today = dateOnlyUtc(now);

  // (1) Tenant opt-out gate. We surface `skipped: true` so the caller can omit
  //     the notification dispatch entirely.
  const config = await prisma.tenantConfig.findUnique({
    where: { tenantId: params.tenantId },
    select: { vocationalSchoolAutoCleanupShifts: true },
  });
  if (config && config.vocationalSchoolAutoCleanupShifts === false) {
    return {
      skipped: true,
      futureSoftDeleted: 0,
      pastFlagged: 0,
      lockedSkipped: 0,
      affectedShiftIds: [],
    };
  }
  if (params.dates.length === 0) {
    return {
      skipped: false,
      futureSoftDeleted: 0,
      pastFlagged: 0,
      lockedSkipped: 0,
      affectedShiftIds: [],
    };
  }

  // (2) Bulk-fetch ACTIVE shifts on the relevant dates. The `deletedAt: null`
  //     filter honors the Soft-Delete contract — already-removed shifts are
  //     invisible here, which gives us natural idempotency on repeat cleanup.
  const shifts = await prisma.shift.findMany({
    where: {
      employeeId: params.employeeId,
      date: { in: params.dates },
      deletedAt: null,
    },
  });
  if (shifts.length === 0) {
    return {
      skipped: false,
      futureSoftDeleted: 0,
      pastFlagged: 0,
      lockedSkipped: 0,
      affectedShiftIds: [],
    };
  }

  // (3) Locked-month guard — fetch SaldoSnapshots for every month the affected
  //     shifts touch and skip those shifts. Defensive against the rare case
  //     where a future shift falls into a manually-locked month.
  //     Issue #241 (fifth site): both the `gte`/`in` fetch bound and the per-shift lookup
  //     key below MUST use the tenant-TZ-aware periodStart (monthLockBoundUtc, which
  //     delegates to monthRangeUtc) — the SAME conversion the monthly closer writes
  //     periodStart with. A naive Date.UTC(year, month, 1) never matched a real row for a
  //     tenant ahead of UTC (Europe/Berlin), so this guard never actually fired.
  const tenantTz = await getTenantTimezone(prisma, params.tenantId);
  const monthStartIsos = [
    ...new Set(shifts.map((s) => monthLockBoundUtc(s.date, tenantTz).toISOString())),
  ];
  const monthStarts = monthStartIsos.map((iso) => new Date(iso));
  // Phase 100B Plan 07 (W2a, getClosedMonthsForDates) — the discrete `monthStarts` shape. The
  // facade itself does the calendar-date-only key comparison (`toIsoDate` there, mirrored from
  // this file's own — see this file's own `toIsoDate` docblock for why: `periodStart` is
  // `@db.Date`, so a fetched row is UTC midnight of its calendar date, never full-string-equal to
  // the full-precision `monthLockBoundUtc(...)` value). Composite key `${employeeId}::${isoDate}`
  // — this file has exactly one employee, so the lookup below prefixes with it explicitly.
  const lockedMonths = await getClosedMonthsForDates(
    prisma,
    [params.employeeId],
    params.tenantId,
    monthStarts,
  );

  // (4) Walk every shift and apply the appropriate audit-proof branch.
  let futureSoftDeleted = 0;
  let pastFlagged = 0;
  let lockedSkipped = 0;
  const affectedShiftIds: string[] = [];

  for (const shift of shifts) {
    const shiftDate = dateOnlyUtc(shift.date);
    const monthIso = toIsoDate(monthLockBoundUtc(shift.date, tenantTz));

    // (4a) Locked-month: never touch — Revisionssicherheit.
    if (lockedMonths.has(`${params.employeeId}::${monthIso}`)) {
      lockedSkipped++;
      continue;
    }

    // (4b) Future-vs-past bifurcation. `date > today` is strictly future.
    //      `date === today` is treated as past (in-day correction is the
    //      user's responsibility — we don't yank a shift mid-day).
    const isFuture = shiftDate.getTime() > today.getTime();
    if (isFuture) {
      const oldValue = { ...shift };
      await prisma.shift.update({
        where: { id: shift.id },
        data: { deletedAt: now, deletedReason: "AUTO_BS_DAY_CLEANUP" },
      });
      await audit({
        // SYSTEM origin convention — see vocational-school-generator.ts.
        // The originator (PATTERN cron vs. MANUAL insert) lives inside newValue.
        userId: undefined,
        action: "SHIFT_AUTO_SOFT_DELETED",
        entity: "Shift",
        entityId: shift.id,
        oldValue,
        newValue: {
          deletedAt: now,
          deletedReason: "AUTO_BS_DAY_CLEANUP",
          triggerSource: params.triggerSource,
        },
      });
      futureSoftDeleted++;
      affectedShiftIds.push(shift.id);
    } else {
      // Past or today: flag only — Phase 47.2 SHIFT_PAST_IMMUTABLE.
      // No-op suppression: if the row is already flagged, count it as
      // pastFlagged (so the notification still surfaces it) but skip the
      // audit write to avoid log noise on idempotent reruns.
      if (!shift.conflictsWithLeave) {
        await prisma.shift.update({
          where: { id: shift.id },
          data: { conflictsWithLeave: true },
        });
        await audit({
          userId: undefined,
          action: "SHIFT_BS_DAY_CONFLICT_FLAGGED",
          entity: "Shift",
          entityId: shift.id,
          oldValue: { conflictsWithLeave: shift.conflictsWithLeave },
          newValue: { conflictsWithLeave: true, triggerSource: params.triggerSource },
        });
      }
      pastFlagged++;
      affectedShiftIds.push(shift.id);
    }
  }

  return { skipped: false, futureSoftDeleted, pastFlagged, lockedSkipped, affectedShiftIds };
}

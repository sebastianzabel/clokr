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

function monthStartUtc(d: Date): Date {
  return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), 1));
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
  const monthStartIsos = [...new Set(shifts.map((s) => monthStartUtc(s.date).toISOString()))];
  const monthStarts = monthStartIsos.map((iso) => new Date(iso));
  const locks = await prisma.saldoSnapshot.findMany({
    where: {
      employeeId: params.employeeId,
      periodType: "MONTHLY",
      periodStart: { in: monthStarts },
      superseded: false,
    },
    select: { periodStart: true },
  });
  const lockedMonths = new Set(locks.map((l) => l.periodStart.toISOString()));

  // (4) Walk every shift and apply the appropriate audit-proof branch.
  let futureSoftDeleted = 0;
  let pastFlagged = 0;
  let lockedSkipped = 0;
  const affectedShiftIds: string[] = [];

  for (const shift of shifts) {
    const shiftDate = dateOnlyUtc(shift.date);
    const monthIso = monthStartUtc(shift.date).toISOString();

    // (4a) Locked-month: never touch — Revisionssicherheit.
    if (lockedMonths.has(monthIso)) {
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

// Phase 62 — Berufsschultag Auto-Generator (Helper)
//
// Pure helper that reads active EmployeeVocationalSchoolPattern rows for a tenant and
// produces VOCATIONAL_SCHOOL Absence rows for the next N weeks. Reused by:
//   - apps/api/src/routes/vocational-school.ts (POST /generate, GET /preview)
//   - apps/api/src/plugins/vocational-school-generator.ts (daily cron at 02:30)
//
// LOCKED invariants (see CONTEXT.md):
//   - BERSCH-08: Existing Absence rows (any type) for (employeeId, date) are NEVER overwritten.
//                Generator is purely additive.
//   - BERSCH-09: Dates inside a locked month (SaldoSnapshot for (employeeId, MONTHLY, monthStart))
//                are skipped.
//   - Idempotent: re-running within the same window creates ZERO additional rows.
//   - Audit-logged: every CREATE produces an AuditLog entry with userId SYSTEM and
//                   action VOCATIONAL_SCHOOL_AUTO_GENERATED.

import type { PrismaClient } from "@clokr/db";
import { FederalState, AbsenceType } from "@clokr/db";
import type { FastifyInstance } from "fastify";
import { cleanupShiftsForBSAbsence } from "./shift-cleanup";

// ── Phase 80 — Per-tenant generator pause (M-4 mitigation) ───────────────────
// Migration scripts (apps/api/scripts/migrate-bs-to-work-event.ts +
// rollback-work-event-to-bs.ts) call pauseTenantGeneration(tenantId) BEFORE
// opening their migration transaction and resumeTenantGeneration(tenantId)
// AFTER it commits (in a finally block).
//
// Without this hook, the daily 02:30 cron could insert fresh Absence
// VOCATIONAL_SCHOOL rows AFTER the migration's pre-flight count but BEFORE
// the per-tenant transaction commits — those rows would be silently missed.
//
// In-memory only — single-replica execution is the current assumption
// (deferred multi-replica coordination per 80-CONTEXT.md deferred list).
// The runbook (docs/work-event-migration-runbook.md) MANDATES scaling the
// API deployment to 1 replica before --apply runs (W6).
const PAUSED_TENANTS = new Set<string>();

export function pauseTenantGeneration(tenantId: string): void {
  PAUSED_TENANTS.add(tenantId);
}

export function resumeTenantGeneration(tenantId: string): void {
  PAUSED_TENANTS.delete(tenantId);
}

export function isTenantPaused(tenantId: string): boolean {
  return PAUSED_TENANTS.has(tenantId);
}

/**
 * Test-only — reset the pause set between unit tests so suite ordering does
 * not leak state. NOT for production use. Called from `beforeEach` in Plan
 * 80-01 + Plan 80-02 test suites (IN-11).
 */
export function _resetPausedTenantsForTests(): void {
  PAUSED_TENANTS.clear();
}

// ── Public types ─────────────────────────────────────────────────────────────

export interface GeneratorResult {
  created: number;
  skipped: {
    schoolHoliday: number; // Phase 67.2: date falls in SchoolHolidayPeriod for resolved BL
    existing: number; // BERSCH-08: an Absence already exists for (employeeId, date)
    locked: number; // BERSCH-09: month is closed (SaldoSnapshot present)
    preHire: number;
    postExit: number;
    outOfWindow: number; // beyond pattern.validFrom/validUntil
  };
  details?: Array<{
    employeeId: string;
    date: string;
    action: "created" | "skipped";
    reason?: string;
  }>;
}

export interface RunOpts {
  tenantId: string;
  weeksAhead?: number;
  now?: Date;
  dryRun?: boolean;
}

export interface PreviewOpts {
  tenantId: string;
  weeksAhead?: number;
  now?: Date;
}

// app.audit signature copy (see plugins/audit.ts) — kept loose to match the Fastify decorator type.
type AuditFn = FastifyInstance["audit"];

// ── Date helpers (module-private) ────────────────────────────────────────────

/**
 * Return the UTC date (00:00:00.000Z) for the calendar day of `d`.
 * Used to align with Prisma @db.Date column semantics (date-only storage).
 */
function dateOnlyUtc(d: Date): Date {
  return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()));
}

function addDaysUtc(d: Date, days: number): Date {
  const out = new Date(d.getTime());
  out.setUTCDate(out.getUTCDate() + days);
  return out;
}

/**
 * Return the UTC date for the 1st of `d`'s month at 00:00:00.000Z.
 * Used to match SaldoSnapshot.periodStart (which is the month boundary).
 */
function monthStartUtc(d: Date): Date {
  return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), 1));
}

/**
 * Map JS-native getUTCDay (0=Sun..6=Sat) onto the schema's Mo-based convention (0=Mo..6=So).
 * Matches EmployeeShiftPattern.dayOfWeek and EmployeeVocationalSchoolPattern.dayOfWeek.
 */
function dowMondayBased(d: Date): number {
  const native = d.getUTCDay(); // 0=Sun..6=Sat
  return native === 0 ? 6 : native - 1;
}

/**
 * Compute ISO 8601 week number and "ISO week year" for a date.
 * Algorithm: shift to the Thursday of the same ISO week; the ISO week year is the year of that
 * Thursday; the week number is the count of weeks since the first Thursday of that year.
 */
function isoWeekOf(date: Date): { year: number; week: number } {
  const d = new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate()));
  // Day-of-week with Mon=1..Sun=7
  const dayNum = d.getUTCDay() || 7;
  // Shift to Thursday of the same week
  d.setUTCDate(d.getUTCDate() + 4 - dayNum);
  const yearStart = new Date(Date.UTC(d.getUTCFullYear(), 0, 1));
  const week = Math.ceil(((d.getTime() - yearStart.getTime()) / 86_400_000 + 1) / 7);
  return { year: d.getUTCFullYear(), week };
}

function toIsoDate(d: Date): string {
  return d.toISOString().slice(0, 10);
}

// ── Core: shared run + preview implementation ────────────────────────────────

/**
 * Shared implementation. When `dryRun=true`, populates `details[]` and returns counts
 * WITHOUT mutating the DB or calling audit().
 */
async function runOrPreview(
  prisma: PrismaClient,
  audit: AuditFn,
  opts: RunOpts & { dryRun: boolean },
): Promise<GeneratorResult> {
  const now = opts.now ?? new Date();
  // v1.7.4 hotfix — bumped from 4 → 13 weeks (≈ one quarter ahead) so the
  // rolling window spans through typical Schulferien gaps. With 4 weeks the
  // UI showed an empty schedule for AZUBI weekdays in the post-holiday range
  // until the daily cron caught up. 13 weeks covers a full quarter forward.
  const weeksAhead = opts.weeksAhead ?? 13;

  const windowStart = dateOnlyUtc(now);
  const windowEnd = addDaysUtc(windowStart, weeksAhead * 7);

  const result: GeneratorResult = {
    created: 0,
    skipped: {
      schoolHoliday: 0,
      existing: 0,
      locked: 0,
      preHire: 0,
      postExit: 0,
      outOfWindow: 0,
    },
    details: opts.dryRun ? [] : undefined,
  };

  // Phase 67.2 Plan 04 — Track newly-created Absence dates per employee so we can
  // invoke the Shift-Auto-Cleanup hook ONCE per employee at the end of the run
  // (batched notification, no per-day fan-out). Skipped entirely in dryRun.
  const createdDatesByEmployee = new Map<string, Date[]>();

  // 1. Load all active patterns for this tenant whose validity range intersects the window.
  //    Includes Phase 67.2 fields `respectSchoolHolidays` and `federalStateOverride`
  //    via Prisma's default-scalar inclusion.
  const patterns = await prisma.employeeVocationalSchoolPattern.findMany({
    where: {
      isActive: true,
      employee: { tenantId: opts.tenantId },
      validFrom: { lte: windowEnd },
      OR: [{ validUntil: null }, { validUntil: { gte: windowStart } }],
    },
    include: {
      employee: { select: { id: true, hireDate: true, exitDate: true } },
    },
  });

  if (patterns.length === 0) return result;

  // Phase 67.2 — Load tenant federalState as default for school-holiday resolution
  // (overridable per-pattern via federalStateOverride).
  const tenant = await prisma.tenant.findUniqueOrThrow({
    where: { id: opts.tenantId },
    select: { id: true, federalState: true },
  });

  // 2. Bulk-fetch existing Absences in the window for these tenants' employees (idempotency).
  //    Build a set keyed by "employeeId::YYYY-MM-DD" for O(1) lookups.
  const employeeIds = Array.from(new Set(patterns.map((p) => p.employeeId)));
  const existingAbsences = await prisma.absence.findMany({
    where: {
      employeeId: { in: employeeIds },
      deletedAt: null,
      startDate: { gte: windowStart, lte: windowEnd },
    },
    select: { employeeId: true, startDate: true },
  });
  const existingSet = new Set<string>(
    existingAbsences.map((a) => `${a.employeeId}::${toIsoDate(a.startDate)}`),
  );

  // 3. Bulk-fetch SaldoSnapshots whose periodStart falls in the window's month range.
  //    Locked months are identified by (employeeId, MONTHLY, monthStartUtc(date)).
  const lockedSnapshots = await prisma.saldoSnapshot.findMany({
    where: {
      employeeId: { in: employeeIds },
      periodType: "MONTHLY",
      periodStart: { gte: monthStartUtc(windowStart), lte: monthStartUtc(windowEnd) },
      superseded: false,
    },
    select: { employeeId: true, periodStart: true },
  });
  const lockedSet = new Set<string>(
    lockedSnapshots.map((s) => `${s.employeeId}::${toIsoDate(s.periodStart)}`),
  );

  // 4. Phase 67.2 — Bulk-fetch SchoolHolidayPeriods for every federal state we will
  //    consult (tenant.federalState + every distinct Pattern.federalStateOverride).
  //    The cache is per-tenant (filtered by tenantId for multi-tenant isolation,
  //    Threat T-67.2-09) and only contains periods that overlap the window.
  //
  //    Stale-cache fallback: if a state's periods are missing entirely (sync hasn't
  //    populated yet or upstream is down), isSchoolHoliday() returns false for that
  //    state and the generator behaves as if no holidays exist (RESEARCH §128 safe
  //    degradation).
  const neededStates = new Set<FederalState>([tenant.federalState]);
  for (const p of patterns) {
    if (p.federalStateOverride) neededStates.add(p.federalStateOverride);
  }
  const holidayPeriods = await prisma.schoolHolidayPeriod.findMany({
    where: {
      tenantId: opts.tenantId,
      federalState: { in: [...neededStates] },
      // Period overlap: period.startDate <= windowEnd AND period.endDate >= windowStart
      startDate: { lte: windowEnd },
      endDate: { gte: windowStart },
    },
    select: { federalState: true, startDate: true, endDate: true },
  });
  // Index by federalState for O(1) bucket access; we scan within-bucket
  // (typically <20 entries/year/BL).
  const holidaysByState = new Map<FederalState, Array<{ startDate: Date; endDate: Date }>>();
  for (const h of holidayPeriods) {
    let bucket = holidaysByState.get(h.federalState);
    if (!bucket) {
      bucket = [];
      holidaysByState.set(h.federalState, bucket);
    }
    bucket.push({ startDate: h.startDate, endDate: h.endDate });
  }

  function isSchoolHoliday(date: Date, fs: FederalState): boolean {
    const periods = holidaysByState.get(fs);
    if (!periods) return false;
    const t = date.getTime();
    for (const p of periods) {
      if (t >= p.startDate.getTime() && t <= p.endDate.getTime()) return true;
    }
    return false;
  }

  // 5. Iterate patterns × candidate dates, applying skip-conditions in order.
  for (const pattern of patterns) {
    const employee = pattern.employee;
    const patternValidUntil = pattern.validUntil;
    const patternValidFrom = pattern.validFrom;

    // Phase 67.2 — Resolve effective federal state + opt-out flag per pattern.
    // `respectSchoolHolidays === false` is the Pflegeschule / Berufsakademie
    // opt-out: holidays do NOT apply. `federalStateOverride` is the
    // Pendler-Azubi case (BS in a different BL than the employer's tenant).
    const effectiveFs: FederalState = pattern.federalStateOverride ?? tenant.federalState;
    const skipHolidayCheck = pattern.respectSchoolHolidays === false;

    // Phase 67.1 — Multi-day weekday support. `daysOfWeek Int[]` is the canonical
    // source; legacy single-value `dayOfWeek Int?` is folded in for old rows that
    // pre-date the v1.7.4 migration and may have an empty `daysOfWeek` array.
    // Existing DB rows have been backfilled, but we keep the fallback so a fresh
    // backup-restored row from v1.7.3 still generates correctly during the soak.
    const weekdaySet = new Set<number>(pattern.daysOfWeek);
    if (weekdaySet.size === 0 && pattern.dayOfWeek != null) {
      weekdaySet.add(pattern.dayOfWeek);
    }
    const hasWeekday = weekdaySet.size > 0;
    const hasBlockWeeks = pattern.blockWeeks.length > 0 && pattern.blockYear != null;

    // Iterate every day in the rolling window.
    for (let i = 0; i <= weeksAhead * 7; i++) {
      const date = addDaysUtc(windowStart, i);

      // (a) Pre-hire / post-exit guards — keyed on employee lifecycle.
      const hireDate = dateOnlyUtc(employee.hireDate);
      if (date < hireDate) {
        // Skipping for this pattern; counted once per skipped date.
        // We only count if a pattern would have produced this date — check after weekday/block check.
      }

      // (b) Decide if this pattern intends to produce a row for this date.
      let intended = false;
      if (hasWeekday && weekdaySet.has(dowMondayBased(date))) {
        intended = true;
      }
      if (hasBlockWeeks) {
        const iso = isoWeekOf(date);
        // v1.7.4 hotfix — Blockunterricht runs Mo-Fr per BBiG §15 Abs.1 Nr.3
        // (25h / mind. 5 Tage) and IHK/HWK/BASS-NRW practice. Sa/So are never
        // school days under the standard 5-day-Berufsschulwoche; explicit
        // Sa-models ("Berufsschule Plus") are out of scope for v1.7.x. See
        // .planning/debug/bs-blockweek-weekday-research.md
        const dow = dowMondayBased(date);
        const isWeekday = dow >= 0 && dow <= 4;
        if (isWeekday && iso.year === pattern.blockYear && pattern.blockWeeks.includes(iso.week)) {
          intended = true;
        }
      }
      if (!intended) continue;

      // (c) Now apply skip conditions in order.
      // Pre-hire
      if (date < hireDate) {
        result.skipped.preHire++;
        if (opts.dryRun) {
          result.details!.push({
            employeeId: employee.id,
            date: toIsoDate(date),
            action: "skipped",
            reason: "preHire",
          });
        }
        continue;
      }
      // Post-exit
      if (employee.exitDate && date > dateOnlyUtc(employee.exitDate)) {
        result.skipped.postExit++;
        if (opts.dryRun) {
          result.details!.push({
            employeeId: employee.id,
            date: toIsoDate(date),
            action: "skipped",
            reason: "postExit",
          });
        }
        continue;
      }
      // Out-of-pattern-window (validFrom/validUntil)
      if (date < dateOnlyUtc(patternValidFrom)) {
        result.skipped.outOfWindow++;
        if (opts.dryRun) {
          result.details!.push({
            employeeId: employee.id,
            date: toIsoDate(date),
            action: "skipped",
            reason: "outOfWindow",
          });
        }
        continue;
      }
      if (patternValidUntil && date > dateOnlyUtc(patternValidUntil)) {
        result.skipped.outOfWindow++;
        if (opts.dryRun) {
          result.details!.push({
            employeeId: employee.id,
            date: toIsoDate(date),
            action: "skipped",
            reason: "outOfWindow",
          });
        }
        continue;
      }
      // (c.5) School-Holiday skip (Phase 67.2). MUST run BEFORE BERSCH-08 existing
      // check so the `schoolHoliday` counter is accurate and idempotency holds
      // on reruns (RESEARCH §198 pitfall #8). When `respectSchoolHolidays=false`
      // (Pflegeschule opt-out) we bypass this branch entirely.
      if (!skipHolidayCheck && isSchoolHoliday(date, effectiveFs)) {
        result.skipped.schoolHoliday++;
        if (opts.dryRun) {
          result.details!.push({
            employeeId: employee.id,
            date: toIsoDate(date),
            action: "skipped",
            reason: "schoolHoliday",
          });
        }
        continue;
      }
      // Existing Absence (BERSCH-08)
      const existKey = `${employee.id}::${toIsoDate(date)}`;
      if (existingSet.has(existKey)) {
        result.skipped.existing++;
        if (opts.dryRun) {
          result.details!.push({
            employeeId: employee.id,
            date: toIsoDate(date),
            action: "skipped",
            reason: "existing",
          });
        }
        continue;
      }
      // Locked month (BERSCH-09)
      const lockKey = `${employee.id}::${toIsoDate(monthStartUtc(date))}`;
      if (lockedSet.has(lockKey)) {
        result.skipped.locked++;
        if (opts.dryRun) {
          result.details!.push({
            employeeId: employee.id,
            date: toIsoDate(date),
            action: "skipped",
            reason: "locked",
          });
        }
        continue;
      }

      // (d) CREATE (or record as dry-run "created").
      if (opts.dryRun) {
        result.created++;
        result.details!.push({
          employeeId: employee.id,
          date: toIsoDate(date),
          action: "created",
        });
      } else {
        // v1.7.4 hotfix — guard against concurrent generator runs racing on the
        // same (employeeId, startDate, type) UNIQUE constraint. The PUT pattern
        // handler fires a fire-and-forget generator on save; that can collide
        // with the daily cron or the explicit POST /vocational-school/generate
        // endpoint (used by tests). Treat P2002 (Prisma unique-violation) as a
        // benign "already created by parallel run" and bump the existing-skip
        // counter instead of bubbling the error up.
        let absence;
        try {
          absence = await prisma.absence.create({
            data: {
              employeeId: employee.id,
              type: AbsenceType.VOCATIONAL_SCHOOL,
              source: "PATTERN", // Phase 63 D-22: distinguishes auto-generated rows from MANUAL (D-23) inserts
              startDate: date,
              endDate: date,
              days: 1.0,
              createdBy: "SYSTEM",
            },
          });
        } catch (err: unknown) {
          if (
            err &&
            typeof err === "object" &&
            "code" in err &&
            (err as { code: unknown }).code === "P2002"
          ) {
            // v1.7.4 hotfix — P2002 means the @@unique(employeeId, startDate, type)
            // already has a row. Two scenarios: (a) a parallel run created it
            // (benign — skip), or (b) a previous orphan-sweep soft-deleted it
            // and the pattern now claims this date again (restore it!). Without
            // the restore branch the row would be stuck in soft-deleted state
            // forever, leaving the user with a missing BS-day in the Schichtplan.
            const existing = await prisma.absence.findUnique({
              where: {
                employeeId_startDate_type: {
                  employeeId: employee.id,
                  startDate: date,
                  type: AbsenceType.VOCATIONAL_SCHOOL,
                },
              },
            });
            if (existing && existing.deletedAt !== null) {
              absence = await prisma.absence.update({
                where: { id: existing.id },
                data: {
                  deletedAt: null,
                  source: "PATTERN",
                  createdBy: "SYSTEM",
                },
              });
              // Fall through to the audit + counted-as-created path below.
            } else {
              result.skipped.existing++;
              if (opts.dryRun) {
                result.details!.push({
                  employeeId: employee.id,
                  date: toIsoDate(date),
                  action: "skipped",
                  reason: "existing",
                });
              }
              continue;
            }
          } else {
            throw err;
          }
        }
        // userId is null (FK column) — the SYSTEM-origin marker lives inside newValue.
        // Encoding the originator inside newValue is the established convention for
        // SYSTEM-owned mutations (AuditLog.userId has @relation onDelete: SetNull and
        // no User row with id="SYSTEM" exists in the data model).
        await audit({
          userId: undefined,
          action: "VOCATIONAL_SCHOOL_AUTO_GENERATED",
          entity: "Absence",
          entityId: absence.id,
          newValue: {
            origin: "SYSTEM",
            employeeId: employee.id,
            date: toIsoDate(date),
            type: AbsenceType.VOCATIONAL_SCHOOL,
            patternId: pattern.id,
          },
        });
        // Add to existingSet so a second pattern hitting the same day won't double-create
        // (e.g. weekday + block-week both match in the same iteration).
        existingSet.add(existKey);
        result.created++;
        // Phase 67.2 Plan 04 — record the new BS-day so the Shift-Auto-Cleanup hook
        // can scan it after the loop completes.
        let bucket = createdDatesByEmployee.get(employee.id);
        if (!bucket) {
          bucket = [];
          createdDatesByEmployee.set(employee.id, bucket);
        }
        bucket.push(date);
      }
    }
  }

  // Phase 67.2 Plan 04 — Shift-Auto-Cleanup hook. Runs ONCE per employee after all
  // Absences are created in the run (batched notification). Skipped in dryRun.
  // Tenant opt-out is honored inside cleanupShiftsForBSAbsence(); the helper returns
  // { skipped: true } when vocationalSchoolAutoCleanupShifts=false.
  if (!opts.dryRun && createdDatesByEmployee.size > 0) {
    await dispatchShiftCleanupForCreatedAbsences(
      prisma,
      audit,
      opts.tenantId,
      createdDatesByEmployee,
      now,
      "PATTERN",
    );
  }

  // v1.7.4 hotfix — Orphan PATTERN-Absence cleanup.
  // When a user deselects a weekday from their pattern (e.g. removes Fr from
  // [Mo, Fr]), the previously-generated PATTERN Absences for the removed day
  // stay in DB and continue to render in the Schichtplan. This sweep finds
  // PATTERN-source Absences in the rolling window that no longer match ANY
  // active pattern's daysOfWeek / blockWeeks intent and soft-deletes them.
  // Source=MANUAL rows are NEVER touched (user-curated, audit-proof). Locked
  // months are skipped (Revisionssicherheit / Phase 47.2 immutability).
  if (!opts.dryRun) {
    const intendedSet = new Set<string>();
    for (const pattern of patterns) {
      const weekdaySet = new Set<number>(pattern.daysOfWeek);
      if (weekdaySet.size === 0 && pattern.dayOfWeek != null) {
        weekdaySet.add(pattern.dayOfWeek);
      }
      const hasWeekday = weekdaySet.size > 0;
      const hasBlockWeeks = pattern.blockWeeks.length > 0 && pattern.blockYear != null;
      const patternStart = dateOnlyUtc(pattern.validFrom);
      const patternEnd = pattern.validUntil ? dateOnlyUtc(pattern.validUntil) : null;
      // v1.7.4 hotfix — Resolve effective Bundesland + Ferien-opt-out per pattern
      // so the intended-set respects the SAME skip rules the create-loop applies.
      // Without this, dates that were generated BEFORE the SchoolHolidayPeriod
      // cache was populated (e.g. first PUT racing with on-demand sync) stay
      // orphaned in Ferien and continue to render in the Schichtplan.
      const patEffectiveFs: FederalState = pattern.federalStateOverride ?? tenant.federalState;
      const patSkipHolidayCheck = pattern.respectSchoolHolidays === false;
      for (let i = 0; i <= weeksAhead * 7; i++) {
        const date = addDaysUtc(windowStart, i);
        // Respect the pattern's own validity window — outside it, the pattern
        // has no claim on this date and the existing-Absence is not its child.
        if (date < patternStart) continue;
        if (patternEnd && date > patternEnd) continue;
        let matches = false;
        if (hasWeekday && weekdaySet.has(dowMondayBased(date))) matches = true;
        if (hasBlockWeeks) {
          const iso = isoWeekOf(date);
          // v1.7.4 hotfix — Same Mo-Fr filter as create-loop above. Without
          // this the orphan-sweep would falsely re-claim Sa/So absences left
          // over from pre-fix runs and keep them active in the DB.
          const dow = dowMondayBased(date);
          const isWeekday = dow >= 0 && dow <= 4;
          if (
            isWeekday &&
            iso.year === pattern.blockYear &&
            pattern.blockWeeks.includes(iso.week)
          ) {
            matches = true;
          }
        }
        if (!matches) continue;
        // v1.7.4 hotfix — Ferien-aware orphan sweep. If THIS pattern would skip
        // the date as a school holiday during the create loop, this pattern does
        // NOT actually claim the date — drop it from intendedSet.
        if (!patSkipHolidayCheck && isSchoolHoliday(date, patEffectiveFs)) continue;
        intendedSet.add(`${pattern.employeeId}::${toIsoDate(date)}`);
      }
    }

    const orphanCandidates = await prisma.absence.findMany({
      where: {
        employeeId: { in: employeeIds },
        type: AbsenceType.VOCATIONAL_SCHOOL,
        source: "PATTERN",
        deletedAt: null,
        startDate: { gte: windowStart, lte: windowEnd },
      },
    });

    for (const a of orphanCandidates) {
      const key = `${a.employeeId}::${toIsoDate(a.startDate)}`;
      if (intendedSet.has(key)) continue;
      // Skip locked-month rows (audit-proof).
      const lockKey = `${a.employeeId}::${toIsoDate(monthStartUtc(a.startDate))}`;
      if (lockedSet.has(lockKey)) continue;

      await prisma.absence.update({
        where: { id: a.id },
        data: { deletedAt: now },
      });
      await audit({
        userId: undefined,
        action: "VOCATIONAL_SCHOOL_AUTO_DELETED",
        entity: "Absence",
        entityId: a.id,
        oldValue: {
          origin: "SYSTEM",
          employeeId: a.employeeId,
          date: toIsoDate(a.startDate),
          source: "PATTERN",
        },
        newValue: {
          origin: "SYSTEM",
          deletedAt: now.toISOString(),
          reason: "orphaned_after_pattern_change",
        },
        request: undefined,
      });
    }
  }

  return result;
}

// ── Phase 67.2 Plan 04 — Shift-Auto-Cleanup dispatcher ───────────────────────
//
// Walks the per-employee createdDates Map and:
//   1. Invokes cleanupShiftsForBSAbsence for each employee with the new BS-dates
//   2. Sends ONE batched Notification per affected employee to all ADMIN+MANAGER
//      users in the tenant (in-app only — the email layer of app.notify() is not
//      wired here because Generator runs without an app instance; the in-app
//      notification surface alone matches the BS-Cleanup UX described in Plan 05).
//
// Exported for reuse by routes/vocational-school.ts (manual-insert D-23).
export async function dispatchShiftCleanupForCreatedAbsences(
  prisma: PrismaClient,
  audit: AuditFn,
  tenantId: string,
  createdDatesByEmployee: Map<string, Date[]>,
  now: Date,
  triggerSource: "PATTERN" | "MANUAL",
): Promise<void> {
  for (const [employeeId, dates] of createdDatesByEmployee) {
    const r = await cleanupShiftsForBSAbsence(prisma, audit, {
      tenantId,
      employeeId,
      dates,
      now,
      triggerSource,
    });
    if (r.skipped) continue;
    if (r.futureSoftDeleted === 0 && r.pastFlagged === 0) continue;

    // Resolve employee display name + recipient list for the batched notification.
    const emp = await prisma.employee.findUnique({
      where: { id: employeeId },
      select: { firstName: true, lastName: true },
    });
    const empName = emp ? `${emp.firstName} ${emp.lastName}` : employeeId;
    const recipients = await prisma.employee.findMany({
      where: {
        tenantId,
        user: { isActive: true, role: { in: ["ADMIN", "MANAGER"] } },
      },
      include: { user: { select: { id: true } } },
    });

    const notificationData = {
      type: "SHIFT_BS_CLEANUP",
      title: "Schichten auf Berufsschultagen",
      message: `Für ${empName}: ${r.futureSoftDeleted} Schicht(en) entfernt, ${r.pastFlagged} markiert`,
      link: "/shifts/conflicts",
      relatedType: "Shift",
      relatedId: r.affectedShiftIds[0] ?? null,
    };
    for (const e of recipients) {
      if (!e.user) continue;
      await prisma.notification.create({
        data: { userId: e.user.id, ...notificationData },
      });
    }
  }
}

// ── Public API ────────────────────────────────────────────────────────────────

export async function runVocationalSchoolGeneration(
  prisma: PrismaClient,
  audit: AuditFn,
  opts: RunOpts,
): Promise<GeneratorResult> {
  // Phase 80 M-4 mitigation — tenant is mid-migration (the script holds the
  // pause boundary). Skip silently; the migration script logs the pause
  // boundary, spamming generator logs adds noise without diagnostic value.
  // The plugin's per-tenant `app.log.info` summary will report `0 erstellt`
  // for paused tenants, which is the operator-visible signal.
  if (isTenantPaused(opts.tenantId)) {
    return {
      created: 0,
      skipped: {
        schoolHoliday: 0,
        existing: 0,
        locked: 0,
        preHire: 0,
        postExit: 0,
        outOfWindow: 0,
      },
    };
  }
  return runOrPreview(prisma, audit, { ...opts, dryRun: opts.dryRun ?? false });
}

export async function previewVocationalSchoolGeneration(
  prisma: PrismaClient,
  opts: PreviewOpts,
): Promise<GeneratorResult> {
  // No-op audit fn for dry-run; runOrPreview never invokes it when dryRun=true anyway.
  const noopAudit: AuditFn = async () => {};
  return runOrPreview(prisma, noopAudit, { ...opts, dryRun: true });
}

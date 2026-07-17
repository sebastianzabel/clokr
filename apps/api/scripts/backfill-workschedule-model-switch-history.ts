/**
 * Operator script — v1.8.16 AZ-model-switch history backfill.
 *
 * Reconstructs missing WorkSchedule history for tenants where an AZ-model
 * switch (e.g. FIXED_SCHEDULE → SHIFT_BASED) was applied without creating a
 * distinct, validFrom-bounded row. The prod defect is a single SHIFT_BASED
 * row with validFrom on or near the employee hire date, despite the actual
 * model switch having occurred on a later month-1st — meaning past saldo
 * closes (Phase 76.22) resolve SHIFT_BASED for pre-switch months that should
 * resolve FIXED_SCHEDULE (or MONTHLY_HOURS).
 *
 * Detection heuristic (conservative, operator-reviewed):
 *   Signal: an employee has exactly ONE WorkSchedule row AND that row has
 *   type != FIXED_SCHEDULE, but evidence exists of earlier non-shift activity —
 *   specifically at least one TimeEntry whose date is BEFORE the single row's
 *   validFrom. When the employee worked (or at least clocked) before the
 *   schedule row's effective date, the hire period must have used a different
 *   schedule model; the single existing row cannot describe the full history.
 *   Proposed corrective row: FIXED_SCHEDULE validFrom = hireDate-aligned month-1st
 *   (or the hireDate itself if the employee was hired mid-month on their first
 *   month, per the issue-#220 / CLAUDE.md exception for initial hire dates).
 *
 *   Limitation (A1): the heuristic requires at least one TimeEntry before the
 *   single schedule row's validFrom to produce a confident candidate.
 *   Employees who switched models but have no time entries in the gap are NOT
 *   flagged (they fall under "cannot determine switch date confidently").
 *   Limitation (A2): the proposed corrective type is always FIXED_SCHEDULE
 *   (the most common "before SHIFT_BASED" state). If the prior model was
 *   MONTHLY_HOURS, the operator must adjust the type before applying.
 *   This is surfaced in the candidate's evidence.evidence_note field.
 *   Limitation (A3): employees with more than one WorkSchedule row are NOT
 *   flagged — they already have a partial history; the operator can compare
 *   rows manually via the admin UI.
 *
 * Invariants:
 *   - NEVER hard-deletes rows (Revisionssicherheit per CLAUDE.md).
 *   - NEVER mutates the existing row's type in place — inserts the missing
 *     historical row as a NEW row.
 *   - NEVER writes to corrective periods that overlap a locked month.
 *     Such candidates appear in summary.skippedLocked for operator review.
 *   - Idempotent: re-running --apply after a successful backfill produces zero
 *     new WorkSchedule rows and zero new AuditLog rows (existing corrective
 *     row is detected before the write attempt).
 *   - Requires explicit tenant scope: --tenant-id OR --all-tenants
 *     (no silent default).
 *   - Every corrective write produces exactly one AuditLog row
 *     (action WORKSCHEDULE_MODEL_SWITCH_BACKFILL) with full context in oldValue.
 *
 * Usage:
 *   DATABASE_URL=... pnpm --filter @clokr/api exec tsx \
 *     scripts/backfill-workschedule-model-switch-history.ts \
 *     ( --tenant-id <uuid> | --all-tenants ) \
 *     [--apply] \
 *     [--help]
 *
 * Without --apply: dry-run (prints candidate list + proposed corrective rows
 *                  as a JSON summary, zero writes).
 * With    --apply: for each confirmed (non-locked, non-manual-review) candidate,
 *                  opens one $transaction (WorkSchedule.create + AuditLog.create)
 *                  for atomicity. Never alters the existing row.
 */
import { PrismaClient } from "@clokr/db";
import { PrismaPg } from "@prisma/adapter-pg";
import pg from "pg";
import { parseArgs } from "node:util";
import { normalizeWorkDays } from "../src/utils/calculate-work-days";

// ── Audit constants ─────────────────────────────────────────────────────────
const BACKFILL_ACTION = "WORKSCHEDULE_MODEL_SWITCH_BACKFILL";
const BACKFILL_USER_AGENT = "script:backfill-workschedule-model-switch-history";

// ── Exported types ──────────────────────────────────────────────────────────
export type CliArgs = {
  tenantId: string | null;
  allTenants: boolean;
  apply: boolean;
  help: boolean;
};

/** Evidence that convinced the heuristic this employee is a candidate. */
export type CandidateEvidence = {
  /** Earliest TimeEntry date before the single schedule row's validFrom. */
  earliestEntryBeforeSchedule: string;
  /** Total TimeEntry count before the single schedule row's validFrom. */
  entryCountBeforeSchedule: number;
  /** Proposed corrective schedule type (see Limitation A2). */
  proposedType: string;
  /** Human-readable note about the proposed corrective type. */
  evidenceNote: string;
};

export type ProposedCorrectiveRow = {
  employeeId: string;
  /** The schedule type for the corrective (historical pre-switch) row. */
  type: string;
  /** month-1st (UTC midnight) for the corrective row's validFrom. */
  validFrom: Date;
  /** weeklyHours to copy from existing row (or null for MONTHLY_HOURS). */
  weeklyHours: number | null;
  mondayHours: number;
  tuesdayHours: number;
  wednesdayHours: number;
  thursdayHours: number;
  fridayHours: number;
  saturdayHours: number;
  sundayHours: number;
  workDays: number[];
};

export type BackfillCandidate = {
  employeeId: string;
  tenantId: string;
  employeeNumber: string;
  hireDate: Date | null;
  existingRow: {
    id: string;
    type: string;
    validFrom: Date;
  };
  proposedCorrectiveRow: ProposedCorrectiveRow;
  evidence: CandidateEvidence;
  /** True if the corrective period overlaps a locked month — not written on --apply. */
  needsManualReview: boolean;
};

export type BackfillSummary = {
  dryRun: boolean;
  tenantsScanned: number;
  employeesScanned: number;
  candidates: BackfillCandidate[];
  written: number;
  unchanged: number;
  skippedLocked: Array<{
    employeeId: string;
    tenantId: string;
    proposedValidFrom: Date;
  }>;
  errors: Array<{
    employeeId: string;
    tenantId: string;
    error: string;
  }>;
};

// ── Usage block ─────────────────────────────────────────────────────────────
const USAGE = `Usage: tsx scripts/backfill-workschedule-model-switch-history.ts \\
  ( --tenant-id <uuid> | --all-tenants ) \\
  [--apply] \\
  [--help]

  --tenant-id    Scope to a single tenant (UUID).
  --all-tenants  Scope to every tenant in the database.
                 (One of --tenant-id OR --all-tenants is REQUIRED — no silent default.)
  --apply        Opt-in flag. Without it the script runs dry-run (prints candidate list
                 + proposed corrective rows as JSON, writes nothing).
  --help         Print this usage block and exit 0.

Safety:
  - Detection: employees with exactly ONE WorkSchedule row whose type is not FIXED_SCHEDULE,
    AND at least one TimeEntry dated before that row's validFrom.
  - NEVER mutates the existing WorkSchedule row — inserts a new historical row.
  - NEVER hard-deletes any WorkSchedule row (Revisionssicherheit per CLAUDE.md).
  - Corrective periods overlapping a locked month are skipped on --apply and surfaced
    for manual review (Revisionssicherheit per CLAUDE.md "Immutability after lock").
  - Idempotent: re-running --apply after a successful backfill writes zero new rows.
  - Every corrective write produces exactly one AuditLog row (action ${BACKFILL_ACTION}).
  - Proposed corrective type is FIXED_SCHEDULE (most common pre-shift state). Review
    candidates where the prior model may have been MONTHLY_HOURS before applying.
`;

// ── CLI parsing ─────────────────────────────────────────────────────────────
export function parseCli(argv: string[]): CliArgs {
  const { values } = parseArgs({
    args: argv,
    options: {
      "tenant-id": { type: "string" },
      "all-tenants": { type: "boolean", default: false },
      apply: { type: "boolean", default: false },
      help: { type: "boolean", default: false },
    },
    strict: true,
  });

  return {
    tenantId: values["tenant-id"] ?? null,
    allTenants: Boolean(values["all-tenants"]),
    apply: Boolean(values["apply"]),
    help: Boolean(values["help"]),
  };
}

// ── Locked-period detection ─────────────────────────────────────────────────
/**
 * Returns true if any TimeEntry in the period [periodStart, periodEnd) for the
 * given employee has isLocked: true. This is the canonical locked-month signal
 * used throughout the codebase (per CLAUDE.md "Immutability after lock").
 */
async function isPeriodLocked(
  prisma: PrismaClient,
  employeeId: string,
  periodStart: Date,
  periodEnd: Date,
): Promise<boolean> {
  const lockedCount = await prisma.timeEntry.count({
    where: {
      employeeId,
      deletedAt: null,
      date: { gte: periodStart, lt: periodEnd }, // exclusive upper bound: corrective row ends before existingRow.validFrom
      isLocked: true,
    },
  });
  return lockedCount > 0;
}

// ── Month-1st helper ────────────────────────────────────────────────────────
/**
 * Returns the UTC midnight Date for the 1st of the calendar month containing
 * the given date (UTC). Used to derive the corrective row's validFrom.
 */
function toMonthFirst(d: Date): Date {
  return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), 1));
}

// ── Main entry point ────────────────────────────────────────────────────────
/**
 * Main entry point. Exported for unit-testability — pass a PrismaClient to
 * inject a test connection; without one the function creates its own.
 */
export async function main(
  argv: string[],
  injectedPrisma?: PrismaClient,
): Promise<BackfillSummary> {
  const args = parseCli(argv);

  if (args.help) {
    console.info(USAGE);
    return {
      dryRun: true,
      tenantsScanned: 0,
      employeesScanned: 0,
      candidates: [],
      written: 0,
      unchanged: 0,
      skippedLocked: [],
      errors: [],
    };
  }

  if (!args.tenantId && !args.allTenants) {
    throw new Error(
      "Tenant-Auswahl erforderlich: bitte --tenant-id <uuid> ODER --all-tenants angeben.",
    );
  }

  const prisma = injectedPrisma ?? new PrismaClient();
  const ownsPrisma = !injectedPrisma;

  try {
    const summary: BackfillSummary = {
      dryRun: !args.apply,
      tenantsScanned: 0,
      employeesScanned: 0,
      candidates: [],
      written: 0,
      unchanged: 0,
      skippedLocked: [],
      errors: [],
    };

    // ── Resolve tenant list ──────────────────────────────────────────────
    const tenants = args.allTenants
      ? await prisma.tenant.findMany({ select: { id: true } })
      : [{ id: args.tenantId! }];
    summary.tenantsScanned = tenants.length;

    for (const t of tenants) {
      // ── Find employees with exactly ONE WorkSchedule row ─────────────
      // The defect signature: a single non-FIXED_SCHEDULE row that predates
      // the actual model switch. Employees with ≥ 2 rows already have partial
      // history; they are out of scope (see Limitation A3).
      const allEmployees = await prisma.employee.findMany({
        where: { tenantId: t.id },
        select: {
          id: true,
          employeeNumber: true,
          hireDate: true,
          workSchedules: {
            orderBy: { validFrom: "asc" },
            select: {
              id: true,
              type: true,
              validFrom: true,
              weeklyHours: true,
              mondayHours: true,
              tuesdayHours: true,
              wednesdayHours: true,
              thursdayHours: true,
              fridayHours: true,
              saturdayHours: true,
              sundayHours: true,
              workDays: true,
            },
          },
        },
      });

      summary.employeesScanned += allEmployees.length;

      for (const emp of allEmployees) {
        // Exactly one WorkSchedule row — and NOT the baseline FIXED_SCHEDULE type.
        // A FIXED_SCHEDULE row by itself is either correct or was always FIXED_SCHEDULE.
        if (emp.workSchedules.length !== 1) continue;
        const singleRow = emp.workSchedules[0];
        if (!singleRow) continue;
        if (singleRow.type === "FIXED_SCHEDULE") continue;

        try {
          // ── Check for TimeEntries BEFORE the schedule row's validFrom ─
          // Evidence that this employee was active (had time entries) in a period
          // that predates the only schedule row — proof of a pre-switch model gap.
          const entryCountBefore = await prisma.timeEntry.count({
            where: {
              employeeId: emp.id,
              deletedAt: null,
              date: { lt: singleRow.validFrom },
            },
          });

          if (entryCountBefore === 0) {
            // No entries before the schedule row → cannot confirm a gap; skip.
            continue;
          }

          // Find the earliest such entry for the evidence record.
          const earliestEntry = await prisma.timeEntry.findFirst({
            where: {
              employeeId: emp.id,
              deletedAt: null,
              date: { lt: singleRow.validFrom },
            },
            orderBy: { date: "asc" },
            select: { date: true },
          });

          const earliestDateStr = earliestEntry!.date.toISOString().slice(0, 10);

          // ── Determine proposedValidFrom for the corrective row ───────
          // The corrective row should be the historical pre-switch schedule.
          // validFrom = month-1st of the employee's earliest activity before
          // the switch (or hireDate if hireDate is within the same month or
          // earlier — the hireDate exception in issue #220 / CLAUDE.md).
          // We pick the month-1st of the earliest entry date as the proposed
          // validFrom; the operator reviews this before applying.
          const proposedValidFrom = toMonthFirst(earliestEntry!.date);

          // ── Build proposed corrective row (copies per-day-hours from existing row) ─
          // The corrective row's per-day fields mirror the existing row so the
          // contract hours are preserved. The TYPE is set to FIXED_SCHEDULE
          // (see Limitation A2 — operators must override if the prior model was
          // MONTHLY_HOURS).
          const perDayHours = {
            mondayHours: Number(singleRow.mondayHours),
            tuesdayHours: Number(singleRow.tuesdayHours),
            wednesdayHours: Number(singleRow.wednesdayHours),
            thursdayHours: Number(singleRow.thursdayHours),
            fridayHours: Number(singleRow.fridayHours),
            saturdayHours: Number(singleRow.saturdayHours),
            sundayHours: Number(singleRow.sundayHours),
          };
          const derivedWorkDays = normalizeWorkDays(
            singleRow.workDays.length > 0 ? singleRow.workDays : undefined,
            perDayHours,
          );

          const proposedCorrectiveRow: ProposedCorrectiveRow = {
            employeeId: emp.id,
            type: "FIXED_SCHEDULE",
            validFrom: proposedValidFrom,
            weeklyHours: singleRow.weeklyHours !== null ? Number(singleRow.weeklyHours) : null,
            ...perDayHours,
            workDays: derivedWorkDays,
          };

          const evidenceNote =
            `Single ${singleRow.type} row (validFrom=${singleRow.validFrom.toISOString().slice(0, 10)}) ` +
            `but ${entryCountBefore} time entr${entryCountBefore === 1 ? "y" : "ies"} exist ` +
            `before that date (earliest: ${earliestDateStr}). ` +
            `Proposed corrective type: FIXED_SCHEDULE (override if prior model was MONTHLY_HOURS).`;

          // ── Check if corrective row already exists (idempotency) ─────
          // If a row already exists with the same {employeeId, validFrom, type},
          // this candidate has already been processed — skip it (no-op).
          const existingCorrectiveRow = await prisma.workSchedule.findFirst({
            where: {
              employeeId: emp.id,
              validFrom: proposedValidFrom,
              type: "FIXED_SCHEDULE",
            },
          });
          if (existingCorrectiveRow) {
            summary.unchanged++;
            continue;
          }

          // ── Locked-period check ──────────────────────────────────────
          // The corrective row affects all months between proposedValidFrom and
          // the existing row's validFrom (exclusive). Check if any of those
          // months are locked.
          // Locked = any TimeEntry with isLocked: true in [proposedValidFrom, existingRow.validFrom)
          const locked = await isPeriodLocked(
            prisma,
            emp.id,
            proposedValidFrom,
            singleRow.validFrom,
          );

          const candidate: BackfillCandidate = {
            employeeId: emp.id,
            tenantId: t.id,
            employeeNumber: emp.employeeNumber,
            hireDate: emp.hireDate,
            existingRow: {
              id: singleRow.id,
              type: singleRow.type,
              validFrom: singleRow.validFrom,
            },
            proposedCorrectiveRow,
            evidence: {
              earliestEntryBeforeSchedule: earliestDateStr,
              entryCountBeforeSchedule: entryCountBefore,
              proposedType: "FIXED_SCHEDULE",
              evidenceNote,
            },
            needsManualReview: locked,
          };

          summary.candidates.push(candidate);

          if (locked) {
            summary.skippedLocked.push({
              employeeId: emp.id,
              tenantId: t.id,
              proposedValidFrom,
            });

            console.warn(
              `[LOCKED] Skipping locked candidate — employeeId=${emp.id} ` +
                `proposedValidFrom=${proposedValidFrom.toISOString().slice(0, 10)} ` +
                `(corrective period overlaps a locked month; manual review required)`,
            );
            continue;
          }

          if (!args.apply) {
            // Dry-run: emit candidate, write nothing.
            console.info(
              `[DRY-RUN] Candidate — employeeId=${emp.id} (${emp.employeeNumber}) ` +
                `existingType=${singleRow.type} existingValidFrom=${singleRow.validFrom.toISOString().slice(0, 10)} ` +
                `→ proposedCorrectiveType=FIXED_SCHEDULE proposedValidFrom=${proposedValidFrom.toISOString().slice(0, 10)}`,
            );
            continue;
          }

          // ── --apply: INSERT corrective row + AuditLog in atomic transaction ─
          // Revisionssicherheit: the existing row is NOT mutated, NOT deleted.
          // A new historical row is inserted at the proposed month-1st validFrom.
          await prisma.$transaction(async (tx) => {
            const newRow = await tx.workSchedule.create({
              data: {
                employeeId: emp.id,
                type: "FIXED_SCHEDULE",
                validFrom: proposedValidFrom,
                weeklyHours: proposedCorrectiveRow.weeklyHours,
                mondayHours: proposedCorrectiveRow.mondayHours,
                tuesdayHours: proposedCorrectiveRow.tuesdayHours,
                wednesdayHours: proposedCorrectiveRow.wednesdayHours,
                thursdayHours: proposedCorrectiveRow.thursdayHours,
                fridayHours: proposedCorrectiveRow.fridayHours,
                saturdayHours: proposedCorrectiveRow.saturdayHours,
                sundayHours: proposedCorrectiveRow.sundayHours,
                workDays: proposedCorrectiveRow.workDays,
              },
            });

            await tx.auditLog.create({
              data: {
                userId: null, // system-initiated (no human actor)
                action: BACKFILL_ACTION,
                entity: "WorkSchedule",
                entityId: newRow.id,
                oldValue: {
                  existingRowId: singleRow.id,
                  existingType: singleRow.type,
                  existingValidFrom: singleRow.validFrom.toISOString(),
                  evidence: candidate.evidence,
                },
                newValue: {
                  type: "FIXED_SCHEDULE",
                  validFrom: proposedValidFrom.toISOString(),
                  weeklyHours: proposedCorrectiveRow.weeklyHours,
                  mondayHours: proposedCorrectiveRow.mondayHours,
                  tuesdayHours: proposedCorrectiveRow.tuesdayHours,
                  wednesdayHours: proposedCorrectiveRow.wednesdayHours,
                  thursdayHours: proposedCorrectiveRow.thursdayHours,
                  fridayHours: proposedCorrectiveRow.fridayHours,
                  saturdayHours: proposedCorrectiveRow.saturdayHours,
                  sundayHours: proposedCorrectiveRow.sundayHours,
                  workDays: proposedCorrectiveRow.workDays,
                },
                ipAddress: null,
                userAgent: BACKFILL_USER_AGENT,
              },
            });
          });

          summary.written++;
          console.info(
            `[APPLIED] Wrote corrective WorkSchedule row — employeeId=${emp.id} ` +
              `type=FIXED_SCHEDULE validFrom=${proposedValidFrom.toISOString().slice(0, 10)}`,
          );
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err);
          summary.errors.push({
            employeeId: emp.id,
            tenantId: t.id,
            error: message,
          });
          console.error(`[ERROR] employeeId=${emp.id}: ${message}`);
        }
      } // end employee loop
    } // end tenant loop

    // eslint-disable-next-line no-console -- intentional structured operator output
    console.log(JSON.stringify(summary, null, 2));
    return summary;
  } finally {
    if (ownsPrisma) {
      await prisma.$disconnect();
    }
  }
}

// ── CLI entrypoint ──────────────────────────────────────────────────────────
const isMain =
  typeof require !== "undefined" && typeof module !== "undefined" && require.main === module;

if (isMain) {
  (async () => {
    // Allow --help to short-circuit before DATABASE_URL / pool construction.
    if (process.argv.includes("--help")) {
      await main(process.argv.slice(2));
      process.exit(0);
    }

    if (!process.env.DATABASE_URL) {
      console.error("DATABASE_URL is required");
      process.exit(1);
    }

    const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL });
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const adapter = new PrismaPg(pool as any);
    const prisma = new PrismaClient({ adapter });

    try {
      await main(process.argv.slice(2), prisma);
    } catch (err) {
      console.error((err as Error).message ?? err);
      process.exit(1);
    } finally {
      await prisma.$disconnect();
      await pool.end();
    }
  })();
}

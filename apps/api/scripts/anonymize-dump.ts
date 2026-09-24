/**
 * Batch anonymizer — Phase 72 Plan 72-01
 *
 * Loops over every employee in the connected database and applies the
 * single-employee DSGVO anonymization from `apps/api/src/utils/anonymize.ts`
 * inside a per-employee transaction. Then writes ONE summary AuditLog entry
 * (action="ANONYMIZATION_RUN") with row counts before/after, duration, and
 * the number of employees processed.
 *
 * Designed to run as a CronJob in the int cluster (Phase 72-02) against a
 * fresh copy of the prod database that has been pg_dump-restored into a
 * staging DB (Phase 72-03). This file ships ONLY the pure-NodeJS logic —
 * no Docker, no SSH, no k3s. End-to-end smoke is against a local dev DB:
 *
 *   pnpm --filter @clokr/api exec tsx scripts/anonymize-dump.ts
 *
 * Exits 0 on success; on any error inside a per-employee transaction the
 * process exits 1 and the run is logged with `error` in newValue. Already-
 * anonymized employees are processed too — the helper is idempotent
 * (re-setting firstName="Gelöscht" is a no-op at the row level).
 *
 * Row-count preservation (D-10): TimeEntry, LeaveRequest, Absence,
 * WorkSchedule, OvertimeAccount counts MUST match pre/post. The script
 * captures both and writes them to AuditLog.newValue so a downstream
 * validator (Plan 72-04) can verify the volume invariant.
 *
 * The AuditLog entry shape (D-08):
 *   {
 *     userId: null,                          // SYSTEM
 *     action: "ANONYMIZATION_RUN",
 *     entity: "Database",
 *     entityId: "run-2026-06-04T20:32:31.000Z",
 *     newValue: {
 *       sourceRowCounts: { ... },
 *       targetRowCounts: { ... },
 *       anonymizedCount: <number>,
 *       removedRoleAssignmentCount: <number>,
 *       removedRoleAssignments: [ ... ],      // one entry per removed RoleAssignment
 *       durationMs: <number>,
 *       error?: <string>,                    // only on failure
 *     }
 *   }
 *
 * Role assignments (Phase 74b, D-22; code review WR-05): `anonymizeEmployeeData` hard-deletes
 * every `RoleAssignment` of the anonymized user and returns the removed rows. The route writes one
 * `DELETE` audit per row; this batch path records them instead in the run summary above —
 * `removedRoleAssignments` carries each row's id plus the same D-12 values the route's `oldValue`
 * carries (userId, accessRoleId, roleName, scopeType, salonIds, employeeIds). Ids and role names
 * only, no personal data. Without this the deletions left no audit trace at all.
 *
 * Importing this module is side-effect-free (no connection, no run): the database is only opened
 * and the sweep only started when the file is executed as a script (run-guard at the bottom), so
 * `scripts/__tests__/anonymize-dump.test.ts` can exercise the exported helpers against a test
 * database. Same pattern as `audit-break-consistency.ts`.
 */
import { PrismaClient } from "@clokr/db";
import { PrismaPg } from "@prisma/adapter-pg";
import pg from "pg";
import { pathToFileURL } from "node:url";

import { anonymizeEmployeeData } from "../src/contexts/platform/anonymize";

/** One removed assignment, as `anonymizeEmployeeData` returns it (route audit `oldValue` + id). */
type RemovedRoleAssignment = Awaited<
  ReturnType<typeof anonymizeEmployeeData>
>["removedRoleAssignments"][number];

interface RowCounts {
  timeEntries: number;
  leaveRequests: number;
  absences: number;
  schedules: number;
  overtimeAccounts: number;
}

async function collectRowCounts(prisma: PrismaClient): Promise<RowCounts> {
  const [timeEntries, leaveRequests, absences, schedules, overtimeAccounts] = await Promise.all([
    prisma.timeEntry.count(),
    prisma.leaveRequest.count(),
    prisma.absence.count(),
    prisma.workSchedule.count(),
    prisma.overtimeAccount.count(),
  ]);
  return { timeEntries, leaveRequests, absences, schedules, overtimeAccounts };
}

/** What one sweep over a list of employees did, before the summary audit row is written. */
export interface AnonymizationBatchResult {
  anonymizedCount: number;
  /** Every RoleAssignment the sweep hard-deleted (D-22), in processing order. */
  removedRoleAssignments: RemovedRoleAssignment[];
  failedEmployeeId: string | null;
  failedError: string | null;
}

/**
 * Anonymizes each employee in its own transaction, in order, and stops at the first failure.
 * Collects the role assignments `anonymizeEmployeeData` removed, so the run summary can record
 * them (74b review WR-05) — a failed employee's transaction rolled back, so it contributes none.
 */
export async function anonymizeEmployeesForRun(
  prisma: PrismaClient,
  employeeIds: string[],
): Promise<AnonymizationBatchResult> {
  const result: AnonymizationBatchResult = {
    anonymizedCount: 0,
    removedRoleAssignments: [],
    failedEmployeeId: null,
    failedError: null,
  };
  for (const employeeId of employeeIds) {
    try {
      const { removedRoleAssignments } = await prisma.$transaction(async (tx) =>
        anonymizeEmployeeData({ tx, employeeId }),
      );
      result.removedRoleAssignments.push(...removedRoleAssignments);
      result.anonymizedCount++;
    } catch (err) {
      result.failedEmployeeId = employeeId;
      result.failedError = err instanceof Error ? err.message : String(err);
      console.error(`[anonymize-dump] FAILED on employee ${employeeId}: ${result.failedError}`);
      break;
    }
  }
  return result;
}

/** The `newValue` of the run's single ANONYMIZATION_RUN audit row (D-08 shape, see docblock). */
export function buildRunSummary(input: {
  sourceRowCounts: RowCounts;
  targetRowCounts: RowCounts;
  durationMs: number;
  batch: AnonymizationBatchResult;
}): Record<string, unknown> {
  const { sourceRowCounts, targetRowCounts, durationMs, batch } = input;
  const newValue: Record<string, unknown> = {
    sourceRowCounts,
    targetRowCounts,
    anonymizedCount: batch.anonymizedCount,
    removedRoleAssignmentCount: batch.removedRoleAssignments.length,
    removedRoleAssignments: batch.removedRoleAssignments,
    durationMs,
  };
  if (batch.failedEmployeeId) {
    newValue.error = `Failed on employeeId=${batch.failedEmployeeId}: ${batch.failedError}`;
  }
  return newValue;
}

async function main(prisma: PrismaClient) {
  const startedAt = Date.now();
  const runId = `run-${new Date(startedAt).toISOString()}`;

  console.log(`[anonymize-dump] starting run ${runId}`);

  const employees = await prisma.employee.findMany({ select: { id: true } });
  console.log(`[anonymize-dump] found ${employees.length} employees`);

  const sourceRowCounts = await collectRowCounts(prisma);

  const batch = await anonymizeEmployeesForRun(
    prisma,
    employees.map((emp) => emp.id),
  );

  const targetRowCounts = await collectRowCounts(prisma);
  const durationMs = Date.now() - startedAt;

  // Volume-preservation invariant (D-10): anonymization mutates rows in
  // place; row counts unchanged. Log a warning if not — downstream
  // validator (Plan 72-04) treats this as a hard failure.
  const volumeMismatch =
    sourceRowCounts.timeEntries !== targetRowCounts.timeEntries ||
    sourceRowCounts.leaveRequests !== targetRowCounts.leaveRequests ||
    sourceRowCounts.absences !== targetRowCounts.absences ||
    sourceRowCounts.schedules !== targetRowCounts.schedules ||
    sourceRowCounts.overtimeAccounts !== targetRowCounts.overtimeAccounts;
  if (volumeMismatch) {
    console.warn(
      `[anonymize-dump] VOLUME MISMATCH — counts changed: ` +
        `source=${JSON.stringify(sourceRowCounts)} target=${JSON.stringify(targetRowCounts)}`,
    );
  }

  const newValue = buildRunSummary({ sourceRowCounts, targetRowCounts, durationMs, batch });

  await prisma.auditLog.create({
    data: {
      userId: null,
      action: "ANONYMIZATION_RUN",
      entity: "Database",
      entityId: runId,
      newValue: newValue as unknown as object,
    },
  });

  if (batch.failedEmployeeId) {
    console.error(
      `[anonymize-dump] partial run: ${batch.anonymizedCount}/${employees.length} anonymized in ${durationMs}ms before failure`,
    );
    process.exitCode = 1;
    return;
  }

  console.log(
    `[anonymize-dump] anonymized ${batch.anonymizedCount}/${employees.length} employees in ${durationMs}ms`,
  );
}

async function run() {
  if (!process.env.DATABASE_URL) {
    console.error("DATABASE_URL is required");
    process.exit(1);
  }

  const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL });
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const adapter = new PrismaPg(pool as any);
  const prisma = new PrismaClient({ adapter });

  await main(prisma)
    .catch((err) => {
      console.error("[anonymize-dump] fatal error:", err);
      process.exitCode = 1;
    })
    .finally(async () => {
      await prisma.$disconnect();
      await pool.end();
    });
}

// Run-guard: only open the database and start the sweep when invoked as a script, so importing
// the module for tests is side-effect-free (no connection, no process.exit, no anonymization).
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  void run();
}

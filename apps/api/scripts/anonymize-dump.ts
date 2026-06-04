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
 *       durationMs: <number>,
 *       error?: <string>,                    // only on failure
 *     }
 *   }
 */
import { PrismaClient } from "@clokr/db";
import { PrismaPg } from "@prisma/adapter-pg";
import pg from "pg";

import { anonymizeEmployeeData } from "../src/utils/anonymize";

if (!process.env.DATABASE_URL) {
  console.error("DATABASE_URL is required");
  process.exit(1);
}

const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL });
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const adapter = new PrismaPg(pool as any);
const prisma = new PrismaClient({ adapter });

interface RowCounts {
  timeEntries: number;
  leaveRequests: number;
  absences: number;
  schedules: number;
  overtimeAccounts: number;
}

async function collectRowCounts(): Promise<RowCounts> {
  const [timeEntries, leaveRequests, absences, schedules, overtimeAccounts] = await Promise.all([
    prisma.timeEntry.count(),
    prisma.leaveRequest.count(),
    prisma.absence.count(),
    prisma.workSchedule.count(),
    prisma.overtimeAccount.count(),
  ]);
  return { timeEntries, leaveRequests, absences, schedules, overtimeAccounts };
}

async function main() {
  const startedAt = Date.now();
  const runId = `run-${new Date(startedAt).toISOString()}`;

  console.log(`[anonymize-dump] starting run ${runId}`);

  const employees = await prisma.employee.findMany({ select: { id: true } });
  console.log(`[anonymize-dump] found ${employees.length} employees`);

  const sourceRowCounts = await collectRowCounts();

  let anonymizedCount = 0;
  let failedEmployeeId: string | null = null;
  let failedError: string | null = null;

  for (const emp of employees) {
    try {
      await prisma.$transaction(async (tx) => {
        await anonymizeEmployeeData({ tx, employeeId: emp.id });
      });
      anonymizedCount++;
    } catch (err) {
      failedEmployeeId = emp.id;
      failedError = err instanceof Error ? err.message : String(err);
      console.error(`[anonymize-dump] FAILED on employee ${emp.id}: ${failedError}`);
      break;
    }
  }

  const targetRowCounts = await collectRowCounts();
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

  const newValue: Record<string, unknown> = {
    sourceRowCounts,
    targetRowCounts,
    anonymizedCount,
    durationMs,
  };
  if (failedEmployeeId) {
    newValue.error = `Failed on employeeId=${failedEmployeeId}: ${failedError}`;
  }

  await prisma.auditLog.create({
    data: {
      userId: null,
      action: "ANONYMIZATION_RUN",
      entity: "Database",
      entityId: runId,
      newValue: newValue as unknown as object,
    },
  });

  if (failedEmployeeId) {
    console.error(
      `[anonymize-dump] partial run: ${anonymizedCount}/${employees.length} anonymized in ${durationMs}ms before failure`,
    );
    process.exitCode = 1;
    return;
  }

  console.log(
    `[anonymize-dump] anonymized ${anonymizedCount}/${employees.length} employees in ${durationMs}ms`,
  );
}

main()
  .catch((err) => {
    console.error("[anonymize-dump] fatal error:", err);
    process.exitCode = 1;
  })
  .finally(async () => {
    await prisma.$disconnect();
    await pool.end();
  });

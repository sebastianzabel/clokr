/**
 * Audit tool - Issue #663: which month snapshots did `backfill-month-snapshots.ts` write for a
 * month in which the regular Monatsabschluss reads leave differently?
 *
 * Background. Until #663 the backfill script read its leave rows with an own query and handed
 * `closeEmployeeMonth` rows without `isOvertimeCompensation` / `creditBasis`, and it counted
 * APPROVED rows only where the regular close counts every effective status (APPROVED and
 * CANCELLATION_REQUESTED, Issue #446). A month backfilled in that state can therefore hold other
 * figures than the regular close would have stored:
 *   - OVERTIME_COMP      an Ueberstundenausgleich leave (#468): the withdrawal was not booked;
 *   - ROSTER_CREDIT      a sick / child-sick / special leave (credit basis ROSTER): a SHIFT_BASED
 *                        employee's Soll relief was priced as a contract day;
 *   - CANCELLATION_REQUESTED  a leave in that status was missing from the month altogether.
 *
 * How a backfilled snapshot is recognised (measured in code, not guessed): the script writes one
 * AuditLog row per closed month with `action = CREATE`, `entity = SaldoSnapshot`, `entityId` = the
 * EMPLOYEE id (not the snapshot id) and `newValue.origin = "BACKFILL"` carrying `year`, `month` and
 * the stored `workedMinutes` / `expectedMinutes` / `balanceMinutes`. The snapshot itself carries no
 * marker. This script therefore finds the audit rows, names the month from them, and looks up the
 * employee's MONTHLY snapshot of that month whose three figures equal the audited ones. A row that
 * has no such snapshot any more (recalculated or superseded since) is listed as `snapshotId=none`.
 *
 * READS ONLY. This file issues `findMany` reads and prints; it contains no write call and takes no
 * write flag. It is a listing, not a gate: the exit code is 0 whenever the run succeeds. The leave
 * rows are read as they are TODAY (status and type may have changed since the backfill ran) - the
 * listing is a pointer for a human look, not a proof of a wrong figure.
 *
 * Output contains ids and calendar months only - no name, no employee number (DSGVO). Full
 * untruncated UUIDs so the owner can find every row.
 *
 * Usage (the owner runs it on int and prod; a read-only database role is enough):
 *   DATABASE_URL=<dsn> pnpm --filter @clokr/api exec tsx \
 *     scripts/audit-663-backfilled-snapshots.ts [--tenant <uuid>]
 *
 * Exit codes: 0 - listing printed; 1 - DATABASE_URL missing, bad CLI or a connection/query failure.
 */
import { PrismaClient } from "@clokr/db";
import { PrismaPg } from "@prisma/adapter-pg";
import pg from "pg";
import { parseArgs } from "node:util";
import { pathToFileURL } from "node:url";
import {
  getTenantTimezone,
  monthDateRange,
  snapshotMonthOf,
} from "../src/contexts/working-time-account";
import { leaveCreditBasisForCode } from "../src/contexts/working-time-account/close-employee-month";
import { EFFECTIVE_LEAVE_STATUSES } from "../src/contexts/absence";

export const EXIT_OK = 0;
export const EXIT_ERROR = 1;

export type AffectedReason = "OVERTIME_COMP" | "ROSTER_CREDIT" | "CANCELLATION_REQUESTED";

/** The minimal leave shape the classifier needs. */
export type LeaveRow = {
  id: string;
  status: string;
  leaveType: { code: string | null } | null;
};

/**
 * Pure: why a month's leave rows are read differently by the regular close than by the backfill
 * as it was. The credit basis comes from `leaveCreditBasisForCode`, the one mapping the saldo core
 * uses - never a second list of codes here.
 */
export function affectedReasons(leave: LeaveRow[]): Map<AffectedReason, string[]> {
  const out = new Map<AffectedReason, string[]>();
  const add = (reason: AffectedReason, id: string) => {
    out.set(reason, [...(out.get(reason) ?? []), id]);
  };
  for (const lr of leave) {
    const code = lr.leaveType?.code ?? null;
    if (code === "OVERTIME_COMP") add("OVERTIME_COMP", lr.id);
    if (leaveCreditBasisForCode(code) === "ROSTER") add("ROSTER_CREDIT", lr.id);
    if (lr.status === "CANCELLATION_REQUESTED") add("CANCELLATION_REQUESTED", lr.id);
  }
  return out;
}

export type BackfillAuditFigures = {
  year: number;
  month: number;
  workedMinutes: number;
  expectedMinutes: number;
  balanceMinutes: number;
};

/** Pure: reads the month and figures out of an audit row's `newValue`; null when malformed. */
export function parseBackfillAudit(newValue: unknown): BackfillAuditFigures | null {
  if (typeof newValue !== "object" || newValue === null) return null;
  const v = newValue as Record<string, unknown>;
  const nums = ["year", "month", "workedMinutes", "expectedMinutes", "balanceMinutes"] as const;
  if (v.origin !== "BACKFILL") return null;
  if (!nums.every((k) => typeof v[k] === "number")) return null;
  return {
    year: v.year as number,
    month: v.month as number,
    workedMinutes: v.workedMinutes as number,
    expectedMinutes: v.expectedMinutes as number,
    balanceMinutes: v.balanceMinutes as number,
  };
}

export type Finding = {
  tenantId: string;
  employeeId: string;
  month: string;
  auditLogId: string;
  /** The snapshot the backfill wrote, null when none matches the audited figures any more. */
  snapshotId: string | null;
  superseded: boolean | null;
  reasons: Map<AffectedReason, string[]>;
};

export type MainOptions = {
  tenantId?: string;
  /** Line sink; defaults to console.info. */
  out?: (line: string) => void;
};

const pad = (n: number): string => String(n).padStart(2, "0");
const CHUNK = 500;

/**
 * Reads the BACKFILL audit rows per tenant and prints every month that holds leave the old backfill
 * read differently. `prisma` is injected so the test can run against a worker database.
 */
export async function main(prisma: PrismaClient, opts: MainOptions = {}): Promise<Finding[]> {
  // eslint-disable-next-line no-console -- a listing script: stdout is its output
  const out = opts.out ?? ((line: string) => console.info(line));
  const tenants = opts.tenantId
    ? [{ id: opts.tenantId }]
    : await prisma.tenant.findMany({ select: { id: true }, orderBy: { id: "asc" } });

  const findings: Finding[] = [];
  for (const { id: tenantId } of tenants) {
    const tz = await getTenantTimezone(prisma, tenantId);
    const employees = await prisma.employee.findMany({
      where: { tenantId },
      select: { id: true },
      orderBy: { id: "asc" },
    });
    let auditRowsSeen = 0;
    const tenantFindings: Finding[] = [];

    for (let i = 0; i < employees.length; i += CHUNK) {
      const ids = employees.slice(i, i + CHUNK).map((e) => e.id);
      const auditRows = await prisma.auditLog.findMany({
        where: {
          action: "CREATE",
          entity: "SaldoSnapshot",
          entityId: { in: ids },
          newValue: { path: ["origin"], equals: "BACKFILL" },
        },
        select: { id: true, entityId: true, newValue: true },
        orderBy: [{ entityId: "asc" }, { createdAt: "asc" }, { id: "asc" }],
      });
      for (const audit of auditRows) {
        const figures = parseBackfillAudit(audit.newValue);
        if (figures === null || audit.entityId === null) continue;
        auditRowsSeen++;
        const employeeId = audit.entityId;

        const snapshots = await prisma.saldoSnapshot.findMany({
          where: { employeeId, periodType: "MONTHLY" },
          select: {
            id: true,
            periodStart: true,
            workedMinutes: true,
            expectedMinutes: true,
            balanceMinutes: true,
            superseded: true,
          },
          orderBy: [{ periodStart: "asc" }, { id: "asc" }],
        });
        const snapshot =
          snapshots.find((s) => {
            const named = snapshotMonthOf(s.periodStart, tz);
            return (
              named?.year === figures.year &&
              named.month === figures.month &&
              s.workedMinutes === figures.workedMinutes &&
              s.expectedMinutes === figures.expectedMinutes &&
              s.balanceMinutes === figures.balanceMinutes
            );
          }) ?? null;

        // @db.Date columns get calendar-day bounds, never the month instants (Issue #493).
        const { firstDay, lastDay } = monthDateRange(figures.year, figures.month, tz);
        const leave = await prisma.leaveRequest.findMany({
          where: {
            employeeId,
            deletedAt: null,
            status: { in: [...EFFECTIVE_LEAVE_STATUSES] },
            startDate: { lte: lastDay },
            endDate: { gte: firstDay },
          },
          select: { id: true, status: true, leaveType: { select: { code: true } } },
          orderBy: { id: "asc" },
        });
        const reasons = affectedReasons(leave);
        if (reasons.size === 0) continue;

        tenantFindings.push({
          tenantId,
          employeeId,
          month: `${figures.year}-${pad(figures.month)}`,
          auditLogId: audit.id,
          snapshotId: snapshot?.id ?? null,
          superseded: snapshot?.superseded ?? null,
          reasons,
        });
      }
    }

    findings.push(...tenantFindings);
    out(`tenant ${tenantId} timeZone=${tz}`);
    out(`  backfill audit rows=${auditRowsSeen} affected months=${tenantFindings.length}`);
    for (const f of tenantFindings) {
      const reasons = [...f.reasons.entries()]
        .map(([reason, ids]) => `${reason}[${ids.join(",")}]`)
        .join(" ");
      out(
        `    tenantId=${tenantId} employeeId=${f.employeeId} month=${f.month} ` +
          `snapshotId=${f.snapshotId ?? "none"} superseded=${f.superseded ?? "n/a"} ` +
          `auditLogId=${f.auditLogId} reasons: ${reasons}`,
      );
    }
  }
  return findings;
}

async function cli(): Promise<number> {
  const { values } = parseArgs({
    args: process.argv.slice(2),
    options: { tenant: { type: "string" } },
    strict: true,
  });
  if (!process.env.DATABASE_URL) {
    console.error("DATABASE_URL is required");
    return EXIT_ERROR;
  }
  const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL });
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const prisma = new PrismaClient({ adapter: new PrismaPg(pool as any) });
  try {
    await main(prisma, { tenantId: values.tenant });
    return EXIT_OK;
  } catch (err) {
    console.error(err);
    return EXIT_ERROR;
  } finally {
    await prisma.$disconnect();
    await pool.end();
  }
}

// Import has no side effect: the CLI runs only when this file is the entry point.
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  void cli().then((code) => process.exit(code));
}

/**
 * Audit tool — Issue #614 (anonymization ends the employment), D-04, AC-614-5.
 *
 * Since Issue #614 a DSGVO anonymization (DELETE /api/v1/employees/:id) sets the exit date when it
 * is empty, keeps the employee number and ends the person's absences after the exit day. Persons
 * anonymized by an EARLIER release were handled by the old rules. This script lists them, so an
 * operator can see the Bestand BEFORE the release that carries #614 is deployed. It corrects
 * nothing: whether and how Bestand rows are corrected is a later, explicit decision (the follow-up
 * issue named in docs/migrations.md, "Phase 614").
 *
 * What it lists: one line per DSGVO-anonymized employee (sentinel `ANONYMIZED_EMPLOYEE_WHERE`) with
 * at least one finding, ordered by tenant id and employee id:
 *   NO_EXIT_DATE       the employee has no exit date (the employment never ended)
 *   LEAVE_AFTER_EXIT   a live leave request (PENDING / APPROVED / CANCELLATION_REQUESTED, not
 *                      soft-deleted) ends after the exit day -> the request ids follow
 *   ABSENCE_AFTER_EXIT a live imposed absence (not soft-deleted) ends after the exit day -> the
 *                      absence ids follow
 *   NUMBER_OVERWRITTEN the employee number still carries the pre-614 overwrite ("GELÖSCHT-…"); the
 *                      old number may survive in the ANONYMIZE audit row of the person, the line
 *                      then says `anonymizeAudit=present` (whether it exists - never the number)
 * A `Totals:` line follows.
 *
 * "After the exit": for a person WITH a stored exit date, after its UTC calendar day (the
 * convention that wrote it); for a person without one, after the tenant-local today (the day an
 * anonymization would set today).
 *
 * Tenants: all of them, deactivated ones included (retention does not end with the contract).
 * `--tenant <id>` narrows the run to one tenant (read-only, for a clean look at a single tenant).
 *
 * READ-ONLY. ZERO mutations: only reads run, there is no write flag and none may ever be added
 * (a stray `--apply` or `--confirm` is rejected before anything is read). The output carries tenant
 * ids, employee ids, request/absence ids and category names only - never a name, an employee
 * number or an e-mail address (DSGVO).
 *
 * Operator step: run it ONCE on int and ONCE on prod BEFORE deploying the release that carries
 * #614, and keep the output.
 *
 * Usage:
 *   DATABASE_URL=<dsn> pnpm tsx scripts/audit-614-anonymized-employment.ts [--tenant <id>] [--help]
 *   (from /app/apps/api in the runtime image, or `pnpm --filter @clokr/api exec tsx scripts/...`)
 *
 * Exit codes:
 *   0 — no finding
 *   2 — at least one finding (the list was printed)
 *   1 — DATABASE_URL missing, bad CLI, or a DB connection/query failure
 */
import { PrismaClient } from "@clokr/db";
import type { Prisma } from "@clokr/db";
import { PrismaPg } from "@prisma/adapter-pg";
import pg from "pg";
import { parseArgs } from "node:util";
import { pathToFileURL } from "node:url";
import { ANONYMIZED_EMPLOYEE_WHERE } from "../src/contexts/platform/employee-anonymization-filter";
import { getTenantTimezone, todayInTz } from "../src/contexts/working-time-account";

// ── Exit codes ──────────────────────────────────────────────────────────────
export const EXIT_OK = 0;
export const EXIT_ERROR = 1;
export const EXIT_FINDINGS = 2;

export type FindingCategory =
  "NO_EXIT_DATE" | "LEAVE_AFTER_EXIT" | "ABSENCE_AFTER_EXIT" | "NUMBER_OVERWRITTEN";

export type AnonymizedEmploymentRow = {
  tenantId: string;
  employeeId: string;
  findings: FindingCategory[];
  leaveRequestIds: string[];
  absenceIds: string[];
  /** Only for NUMBER_OVERWRITTEN: whether an ANONYMIZE audit row of the person exists. */
  anonymizeAuditPresent: boolean | null;
};

/** Everything a PrismaClient or an interactive-transaction client can run. */
type Db = Prisma.TransactionClient;

/** The prefix the pre-614 anonymization wrote into the employee number. */
const OVERWRITTEN_NUMBER_PREFIX = "GELÖSCHT-";

const LIVE_LEAVE_STATUSES = ["PENDING", "APPROVED", "CANCELLATION_REQUESTED"] as const;

function compareStrings(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

const dayOf = (d: Date): string => d.toISOString().slice(0, 10);

/**
 * Every anonymized employee with at least one finding. Exported for the test; the CLI prints it.
 * Reads only - the single place the sentinel is spelled is `ANONYMIZED_EMPLOYEE_WHERE`.
 */
export async function computeAnonymizedEmployment(
  db: Db,
  options: { tenantId?: string } = {},
): Promise<AnonymizedEmploymentRow[]> {
  const tenantFilter = options.tenantId ? { tenantId: options.tenantId } : {};
  const employees = await db.employee.findMany({
    where: { AND: [ANONYMIZED_EMPLOYEE_WHERE, tenantFilter] },
    select: { id: true, tenantId: true, exitDate: true },
  });
  if (employees.length === 0) return [];

  // The pre-614 overwrite is detected by a filter, so the number itself is never read.
  const overwritten = new Set(
    (
      await db.employee.findMany({
        where: {
          AND: [
            ANONYMIZED_EMPLOYEE_WHERE,
            tenantFilter,
            { employeeNumber: { startsWith: OVERWRITTEN_NUMBER_PREFIX } },
          ],
        },
        select: { id: true },
      })
    ).map((e) => e.id),
  );

  // The day an anonymization would set for a person without an exit date: the tenant-local today.
  const tenantToday = new Map<string, string>();
  for (const tenantId of new Set(employees.map((e) => e.tenantId))) {
    const tz = await getTenantTimezone(db as PrismaClient, tenantId);
    tenantToday.set(tenantId, dayOf(todayInTz(tz)));
  }
  const cutoffOf = (e: { tenantId: string; exitDate: Date | null }): string =>
    e.exitDate ? dayOf(e.exitDate) : (tenantToday.get(e.tenantId) as string);

  const ids = employees.map((e) => e.id);
  const byEmployee = new Map(employees.map((e) => [e.id, e]));

  const leaveByEmployee = new Map<string, string[]>();
  for (const request of await db.leaveRequest.findMany({
    where: { employeeId: { in: ids }, deletedAt: null, status: { in: [...LIVE_LEAVE_STATUSES] } },
    select: { id: true, employeeId: true, endDate: true },
  })) {
    const owner = byEmployee.get(request.employeeId);
    if (owner && dayOf(request.endDate) > cutoffOf(owner)) {
      leaveByEmployee.set(request.employeeId, [
        ...(leaveByEmployee.get(request.employeeId) ?? []),
        request.id,
      ]);
    }
  }

  const absenceByEmployee = new Map<string, string[]>();
  for (const absence of await db.absence.findMany({
    where: { employeeId: { in: ids }, deletedAt: null },
    select: { id: true, employeeId: true, endDate: true },
  })) {
    const owner = byEmployee.get(absence.employeeId);
    if (owner && dayOf(absence.endDate) > cutoffOf(owner)) {
      absenceByEmployee.set(absence.employeeId, [
        ...(absenceByEmployee.get(absence.employeeId) ?? []),
        absence.id,
      ]);
    }
  }

  const withAnonymizeAudit = new Set(
    (
      await db.auditLog.findMany({
        where: { action: "ANONYMIZE", entity: "Employee", entityId: { in: [...overwritten] } },
        select: { entityId: true },
      })
    ).map((row) => row.entityId),
  );

  const rows: AnonymizedEmploymentRow[] = [];
  for (const employee of employees) {
    const leaveRequestIds = (leaveByEmployee.get(employee.id) ?? []).sort(compareStrings);
    const absenceIds = (absenceByEmployee.get(employee.id) ?? []).sort(compareStrings);
    const findings: FindingCategory[] = [];
    if (employee.exitDate === null) findings.push("NO_EXIT_DATE");
    if (leaveRequestIds.length > 0) findings.push("LEAVE_AFTER_EXIT");
    if (absenceIds.length > 0) findings.push("ABSENCE_AFTER_EXIT");
    if (overwritten.has(employee.id)) findings.push("NUMBER_OVERWRITTEN");
    if (findings.length === 0) continue;
    rows.push({
      tenantId: employee.tenantId,
      employeeId: employee.id,
      findings,
      leaveRequestIds,
      absenceIds,
      anonymizeAuditPresent: overwritten.has(employee.id)
        ? withAnonymizeAudit.has(employee.id)
        : null,
    });
  }
  return rows.sort(
    (a, b) => compareStrings(a.tenantId, b.tenantId) || compareStrings(a.employeeId, b.employeeId),
  );
}

export function formatRow(row: AnonymizedEmploymentRow): string {
  const parts = [
    `tenant=${row.tenantId}`,
    `employee=${row.employeeId}`,
    `findings=${row.findings.join(",")}`,
  ];
  if (row.leaveRequestIds.length > 0) parts.push(`leaveRequests=${row.leaveRequestIds.join(",")}`);
  if (row.absenceIds.length > 0) parts.push(`absences=${row.absenceIds.join(",")}`);
  if (row.anonymizeAuditPresent !== null) {
    parts.push(`anonymizeAudit=${row.anonymizeAuditPresent ? "present" : "absent"}`);
  }
  return parts.join(" ");
}

export function formatTotals(rows: AnonymizedEmploymentRow[]): string {
  const count = (category: FindingCategory) =>
    rows.filter((row) => row.findings.includes(category)).length;
  return (
    `Totals: employees=${rows.length} noExitDate=${count("NO_EXIT_DATE")} ` +
    `leaveAfterExit=${count("LEAVE_AFTER_EXIT")} absenceAfterExit=${count("ABSENCE_AFTER_EXIT")} ` +
    `numberOverwritten=${count("NUMBER_OVERWRITTEN")}`
  );
}

// ── CLI parsing ───────────────────────────────────────────────────────────────
export type CliArgs = { help: boolean; tenant: string | undefined };

export function parseCli(argv: string[]): CliArgs {
  const { values } = parseArgs({
    args: argv,
    options: {
      help: { type: "boolean", default: false },
      tenant: { type: "string" },
    },
    strict: true, // rejects any unknown flag, in particular --apply / --confirm
  });
  return { help: Boolean(values.help), tenant: values.tenant };
}

export const USAGE = `
Usage:
  DATABASE_URL=<dsn> pnpm tsx scripts/audit-614-anonymized-employment.ts [--tenant <id>] [--help]

READ-ONLY - lists, per tenant id and employee id, every DSGVO-anonymized person whose employment
the pre-614 anonymization did not end (NO_EXIT_DATE, LEAVE_AFTER_EXIT, ABSENCE_AFTER_EXIT,
NUMBER_OVERWRITTEN). Ids and category names only. No write flag exists. Run it on int and prod
BEFORE the deploy.

Exit codes:
  0 - no finding
  2 - at least one finding (the list was printed)
  1 - DATABASE_URL missing, bad CLI, or a DB connection/query failure
`;

/**
 * Exported for unit-testability - pass a client to inject a test connection (worker test DB only);
 * without one the CLI entrypoint below bootstraps its own connection from DATABASE_URL.
 */
export async function main(argv: string[], injectedPrisma?: PrismaClient): Promise<number> {
  let args: CliArgs;
  try {
    args = parseCli(argv);
  } catch (err) {
    console.error(err instanceof Error ? err.message : String(err));
    console.error(USAGE);
    return EXIT_ERROR;
  }

  if (args.help) {
    console.info(USAGE);
    return EXIT_OK;
  }

  if (!injectedPrisma && !process.env.DATABASE_URL) {
    console.error("DATABASE_URL is required");
    return EXIT_ERROR;
  }

  let pool: pg.Pool | undefined;
  let prisma: PrismaClient;
  if (injectedPrisma) {
    prisma = injectedPrisma;
  } else {
    pool = new pg.Pool({ connectionString: process.env.DATABASE_URL });
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const adapter = new PrismaPg(pool as any);
    prisma = new PrismaClient({ adapter });
  }

  try {
    const rows = await computeAnonymizedEmployment(prisma, { tenantId: args.tenant });
    for (const row of rows) console.info(formatRow(row));
    console.info(formatTotals(rows));
    console.info("This script writes nothing.");
    return rows.length > 0 ? EXIT_FINDINGS : EXIT_OK;
  } catch (err) {
    console.error(err instanceof Error ? err.message : String(err));
    return EXIT_ERROR;
  } finally {
    if (!injectedPrisma) {
      await prisma.$disconnect();
      await pool?.end();
    }
  }
}

// Run-guard: only bootstrap the DB + execute when invoked as a script, so importing the module
// for unit tests is side-effect-free (no connection, no process.exit).
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  void main(process.argv.slice(2))
    .then((code) => {
      process.exitCode = code;
    })
    .catch((err: unknown) => {
      console.error(err instanceof Error ? err.message : String(err));
      process.exitCode = EXIT_ERROR;
    });
}

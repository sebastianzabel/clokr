/**
 * Audit tool - Issue #820 (device MAC addresses in AuditLog values of anonymized persons).
 *
 * Since Issue #820 the DSGVO anonymization replaces the device MAC addresses inside the person's
 * audit rows. Persons anonymized by an EARLIER release still have them. This script lists those
 * persons so an operator sees the Bestand; it corrects nothing (a correction is a separate,
 * explicit decision, like #666 after #614).
 *
 * What it lists: one line per DSGVO-anonymized employee (sentinel `ANONYMIZED_EMPLOYEE_WHERE`) with
 * at least one audit row that still holds a MAC, found by the SAME subject rule the anonymization
 * uses (`redactMacAuditOfPerson`, dry mode): tenant id, employee id, the row count and the row count
 * per entity name. A `Totals:` line follows. Never an address, a name, a number or a row id.
 *
 * Tenants: all, deactivated ones included. `--tenant <id>` narrows the run.
 *
 * READ-ONLY. ZERO mutations: there is no write flag and none may be added (a stray `--apply` or
 * `--confirm` is rejected before anything is read).
 *
 * Usage:
 *   DATABASE_URL=<dsn> pnpm tsx scripts/audit-820-anonymized-audit-macs.ts [--tenant <id>] [--help]
 *
 * Exit codes: 0 no finding, 2 at least one finding (the list was printed), 1 error.
 */
import { PrismaClient } from "@clokr/db";
import type { Prisma } from "@clokr/db";
import { PrismaPg } from "@prisma/adapter-pg";
import pg from "pg";
import { parseArgs } from "node:util";
import { pathToFileURL } from "node:url";
import { ANONYMIZED_EMPLOYEE_WHERE } from "../src/contexts/platform/employee-anonymization-filter";
import { redactMacAuditOfPerson } from "../src/contexts/platform/audit-mac-redaction";
import { timeEntryIdsOfEmployee } from "../src/contexts/time-tracking";

export const EXIT_OK = 0;
export const EXIT_ERROR = 1;
export const EXIT_FINDINGS = 2;

type Db = Prisma.TransactionClient;

export type AnonymizedMacRow = {
  tenantId: string;
  employeeId: string;
  auditRows: number;
  byEntity: Record<string, number>;
};

const compareStrings = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);

/** Every anonymized employee with at least one audit row that still holds a MAC. Reads only. */
export async function computeAnonymizedAuditMacs(
  db: Db,
  options: { tenantId?: string } = {},
): Promise<AnonymizedMacRow[]> {
  const employees = await db.employee.findMany({
    where: {
      AND: [ANONYMIZED_EMPLOYEE_WHERE, options.tenantId ? { tenantId: options.tenantId } : {}],
    },
    select: { id: true, tenantId: true, userId: true },
  });
  const rows: AnonymizedMacRow[] = [];
  for (const employee of employees) {
    const found = await redactMacAuditOfPerson(
      db,
      {
        employeeId: employee.id,
        userId: employee.userId,
        deviceIds: [],
        macs: [],
        timeEntryIds: await timeEntryIdsOfEmployee(db, employee.id, employee.tenantId),
      },
      { write: false },
    );
    if (found.rowsWithMac === 0) continue;
    rows.push({
      tenantId: employee.tenantId,
      employeeId: employee.id,
      auditRows: found.rowsWithMac,
      byEntity: found.byEntity,
    });
  }
  return rows.sort(
    (a, b) => compareStrings(a.tenantId, b.tenantId) || compareStrings(a.employeeId, b.employeeId),
  );
}

export function formatRow(row: AnonymizedMacRow): string {
  const entities = Object.entries(row.byEntity)
    .sort(([a], [b]) => compareStrings(a, b))
    .map(([entity, count]) => `${entity}:${count}`)
    .join(",");
  return `tenant=${row.tenantId} employee=${row.employeeId} auditRows=${row.auditRows} entities=${entities}`;
}

export function formatTotals(rows: AnonymizedMacRow[]): string {
  return `Totals: employees=${rows.length} auditRows=${rows.reduce((n, r) => n + r.auditRows, 0)}`;
}

export type CliArgs = { help: boolean; tenant: string | undefined };

export function parseCli(argv: string[]): CliArgs {
  const { values } = parseArgs({
    args: argv,
    options: { help: { type: "boolean", default: false }, tenant: { type: "string" } },
    strict: true, // rejects any unknown flag, in particular --apply / --confirm
  });
  return { help: Boolean(values.help), tenant: values.tenant };
}

export const USAGE = `
Usage:
  DATABASE_URL=<dsn> pnpm tsx scripts/audit-820-anonymized-audit-macs.ts [--tenant <id>] [--help]

READ-ONLY - lists, per tenant id and employee id, every DSGVO-anonymized person whose audit rows
still hold a device MAC address (counts per entity name only, never an address). No write flag.

Exit codes:
  0 - no finding
  2 - at least one finding (the list was printed)
  1 - DATABASE_URL missing, bad CLI, or a DB connection/query failure
`;

/** Exported for the test; pass a client to inject a test connection. */
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
    prisma = new PrismaClient({ adapter: new PrismaPg(pool as any) });
  }
  try {
    const rows = await computeAnonymizedAuditMacs(prisma, { tenantId: args.tenant });
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

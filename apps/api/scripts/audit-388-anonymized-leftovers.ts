/**
 * Audit tool - Issues #388 and #508 (DSGVO Art. 17 gaps of the employee anonymization).
 *
 * Before these issues the anonymization (DELETE /api/v1/employees/:id) left three things behind:
 *   WIFI_MACS            Employee.wifiMacs still holds MAC addresses of private devices
 *   PRESENCE_DEVICES     PresenceDevice rows (MAC + label) of the person still exist
 *   BREAK_WAIVED_REASON  TimeEntry.breakWaivedReason (free text, soft-deleted rows included) is set
 * This script lists every already-anonymized employee (sentinel `ANONYMIZED_EMPLOYEE_WHERE`) that
 * still carries one of them: tenant id, employee id, category and COUNT. A `Totals:` line follows.
 * Whether those Bestand rows are cleaned by a one-off script is an open owner decision (#388), so
 * there is deliberately no backfill here.
 *
 * Tenants: all, deactivated ones included. `--tenant <id>` narrows to one tenant.
 *
 * READ-ONLY. ZERO mutations: only reads run and no write flag exists (a stray `--apply` or
 * `--confirm` is rejected before anything is read). The output carries ids, category names and
 * counts only - never a MAC address, a label, a waiver text or a name (DSGVO).
 *
 * Usage:
 *   DATABASE_URL=<dsn> pnpm --filter @clokr/api exec tsx scripts/audit-388-anonymized-leftovers.ts [--tenant <id>] [--help]
 *
 * Exit codes: 0 no finding / 2 at least one finding / 1 bad CLI, missing DATABASE_URL or DB failure.
 */
import { PrismaClient } from "@clokr/db";
import type { Prisma } from "@clokr/db";
import { PrismaPg } from "@prisma/adapter-pg";
import pg from "pg";
import { parseArgs } from "node:util";
import { pathToFileURL } from "node:url";
import { ANONYMIZED_EMPLOYEE_WHERE } from "../src/contexts/platform/employee-anonymization-filter";

export const EXIT_OK = 0;
export const EXIT_ERROR = 1;
export const EXIT_FINDINGS = 2;

export type LeftoverRow = {
  tenantId: string;
  employeeId: string;
  wifiMacs: number;
  presenceDevices: number;
  breakWaivedReasons: number;
};

type Db = Prisma.TransactionClient;

function compareStrings(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

/** Every anonymized employee that still carries a device identifier or a waiver text. */
export async function computeAnonymizedLeftovers(
  db: Db,
  options: { tenantId?: string } = {},
): Promise<LeftoverRow[]> {
  const tenantFilter = options.tenantId ? { tenantId: options.tenantId } : {};
  const employees = await db.employee.findMany({
    where: { AND: [ANONYMIZED_EMPLOYEE_WHERE, tenantFilter] },
    select: { id: true, tenantId: true, wifiMacs: true },
  });
  if (employees.length === 0) return [];
  const ids = employees.map((e) => e.id);

  const countBy = (rows: { employeeId: string; _count: { _all: number } }[]) =>
    new Map(rows.map((r) => [r.employeeId, r._count._all]));
  // Awaited into a variable first: passed straight into countBy, Prisma's groupBy overload
  // loses its inference and tsc rejects the argument.
  const deviceRows = await db.presenceDevice.groupBy({
    by: ["employeeId"],
    where: { employeeId: { in: ids } },
    _count: { _all: true },
  });
  const devices = countBy(deviceRows);
  // No `deletedAt` filter on purpose: a soft-deleted entry keeps its text and is reached too.
  const waivedRows = await db.timeEntry.groupBy({
    by: ["employeeId"],
    where: { employeeId: { in: ids }, breakWaivedReason: { not: null } },
    _count: { _all: true },
  });
  const waived = countBy(waivedRows);

  const rows: LeftoverRow[] = [];
  for (const e of employees) {
    const row: LeftoverRow = {
      tenantId: e.tenantId,
      employeeId: e.id,
      wifiMacs: e.wifiMacs.length,
      presenceDevices: devices.get(e.id) ?? 0,
      breakWaivedReasons: waived.get(e.id) ?? 0,
    };
    if (row.wifiMacs + row.presenceDevices + row.breakWaivedReasons > 0) rows.push(row);
  }
  return rows.sort(
    (a, b) => compareStrings(a.tenantId, b.tenantId) || compareStrings(a.employeeId, b.employeeId),
  );
}

export function formatRow(row: LeftoverRow): string {
  const findings = [
    row.wifiMacs > 0 ? "WIFI_MACS" : null,
    row.presenceDevices > 0 ? "PRESENCE_DEVICES" : null,
    row.breakWaivedReasons > 0 ? "BREAK_WAIVED_REASON" : null,
  ].filter(Boolean);
  return (
    `tenant=${row.tenantId} employee=${row.employeeId} findings=${findings.join(",")} ` +
    `wifiMacs=${row.wifiMacs} presenceDevices=${row.presenceDevices} ` +
    `breakWaivedReasons=${row.breakWaivedReasons}`
  );
}

export function formatTotals(rows: LeftoverRow[]): string {
  const sum = (pick: (r: LeftoverRow) => number) => rows.reduce((n, r) => n + pick(r), 0);
  return (
    `Totals: employees=${rows.length} wifiMacs=${sum((r) => r.wifiMacs)} ` +
    `presenceDevices=${sum((r) => r.presenceDevices)} ` +
    `breakWaivedReasons=${sum((r) => r.breakWaivedReasons)}`
  );
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
  DATABASE_URL=<dsn> pnpm --filter @clokr/api exec tsx scripts/audit-388-anonymized-leftovers.ts [--tenant <id>] [--help]

READ-ONLY - lists already-anonymized employees that still carry WLAN MAC addresses
(Employee.wifiMacs, PresenceDevice) or a TimeEntry.breakWaivedReason. Ids and counts only.

Exit codes: 0 no finding, 2 at least one finding, 1 error.
`;

/** Exported for tests - pass a client to inject a test connection. */
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
    const rows = await computeAnonymizedLeftovers(prisma, { tenantId: args.tenant });
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

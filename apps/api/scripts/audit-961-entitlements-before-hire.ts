/**
 * Audit tool — Issue #961.
 *
 * Before #961 a hire date moved to a later year left the LeaveEntitlement rows of the years before
 * the new hire year in place, and the carry-over recomputation carried their days into the hire
 * year (example: a 24-day row of the year before the new hire year became a carry of 24). Since
 * #961 a hire-date change sets those rows to 0 (`syncVacationEntitlementsForHireDateChange`,
 * `contexts/absence/hire-date-entitlements.ts`); rows written before the fix stay as they are.
 *
 * What it lists: per employee with at least one LeaveEntitlement row of a year before the UTC year
 * of the hire date (the regular formula's own "employed in year" convention) one line — tenant id,
 * employee id, hire year, the number of such rows, how many of them still carry days
 * (`totalDays` or `carriedOverDays` not 0), how many have used days, and the number of later rows
 * with a carry-over > 0 (the carry that may stem from them). A totals line follows.
 *
 * READ-ONLY. ZERO mutations: only Prisma reads run, there is no write flag, and none may ever be
 * added. Ids and counts only — no name, no mail address; the script never selects those columns.
 *
 * Correction: never by this script. A row is corrected by an audited write — a hire-date change
 * through the employee form runs the #961 rule, or a deliberate correction in the Urlaubsanspruch
 * tab (PUT /settings/vacation).
 *
 * Usage:
 *   DATABASE_URL=<dsn> pnpm --filter @clokr/api exec tsx \
 *     scripts/audit-961-entitlements-before-hire.ts [--help]
 *
 * Exit codes:
 *   0 — no row of a year before the hire year exists
 *   1 — DATABASE_URL missing, bad CLI, or a DB connection/query failure
 *   2 — one or more employees were listed
 */
import { PrismaClient } from "@clokr/db";
import { PrismaPg } from "@prisma/adapter-pg";
import pg from "pg";
import { parseArgs } from "node:util";
import { pathToFileURL } from "node:url";

// ── Exit codes ──────────────────────────────────────────────────────────────
export const EXIT_OK = 0;
export const EXIT_ERROR = 1;
export const EXIT_FINDINGS = 2;

// ── CLI parsing ───────────────────────────────────────────────────────────────
export type CliArgs = { help: boolean };

export function parseCli(argv: string[]): CliArgs {
  const { values } = parseArgs({
    args: argv,
    options: {
      help: { type: "boolean", default: false },
    },
    strict: true, // rejects any unknown flag, in particular --confirm / --apply
  });
  return { help: Boolean(values.help) };
}

export const USAGE = `
Usage:
  DATABASE_URL=<dsn> pnpm --filter @clokr/api exec tsx \\
    scripts/audit-961-entitlements-before-hire.ts [--help]

READ-ONLY — lists every employee with LeaveEntitlement rows of years before the hire year
(Issue #961): tenant id, employee id, hire year and counts, then a totals line. Ids and counts only.
`;

export type EmployeeEntitlements = {
  id: string;
  tenantId: string;
  hireDate: Date;
  leaveEntitlements: {
    year: number;
    totalDays: unknown;
    carriedOverDays: unknown;
    usedDays: unknown;
  }[];
};

export type Finding = {
  tenantId: string;
  employeeId: string;
  hireYear: number;
  rowsBeforeHire: number;
  rowsWithDays: number;
  rowsWithUsedDays: number;
  laterRowsWithCarry: number;
};

/** Pure classification: one finding per employee with a row of a year before the hire year. */
export function entitlementsBeforeHire(employees: readonly EmployeeEntitlements[]): Finding[] {
  const findings: Finding[] = [];
  for (const employee of employees) {
    // The regular formula's own convention: employed in `year` iff the hire date's UTC year <= year.
    const hireYear = employee.hireDate.getUTCFullYear();
    const before = employee.leaveEntitlements.filter((r) => r.year < hireYear);
    if (before.length === 0) continue;
    findings.push({
      tenantId: employee.tenantId,
      employeeId: employee.id,
      hireYear,
      rowsBeforeHire: before.length,
      rowsWithDays: before.filter(
        (r) => Number(r.totalDays) !== 0 || Number(r.carriedOverDays) !== 0,
      ).length,
      rowsWithUsedDays: before.filter((r) => Number(r.usedDays) > 0).length,
      laterRowsWithCarry: employee.leaveEntitlements.filter(
        (r) => r.year >= hireYear && Number(r.carriedOverDays) > 0,
      ).length,
    });
  }
  return findings;
}

/**
 * Exported for unit-testability — pass a PrismaClient to inject a test connection (run against the
 * worker test DB only); without one the CLI entrypoint below bootstraps its own connection from
 * DATABASE_URL.
 */
export async function main(argv: string[], injectedPrisma?: PrismaClient): Promise<number> {
  const args = parseCli(argv);

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
    // Only ids, the hire date and the entitlement figures are selected.
    const employees = await prisma.employee.findMany({
      where: { leaveEntitlements: { some: {} } },
      select: {
        id: true,
        tenantId: true,
        hireDate: true,
        leaveEntitlements: {
          select: { year: true, totalDays: true, carriedOverDays: true, usedDays: true },
        },
      },
      orderBy: [{ tenantId: "asc" }, { id: "asc" }],
    });

    const findings = entitlementsBeforeHire(employees);
    let rowsBeforeHire = 0;
    let rowsWithDays = 0;
    for (const f of findings) {
      rowsBeforeHire += f.rowsBeforeHire;
      rowsWithDays += f.rowsWithDays;
      console.info(
        `tenantId=${f.tenantId} employeeId=${f.employeeId} hireYear=${f.hireYear} ` +
          `rowsBeforeHire=${f.rowsBeforeHire} rowsWithDays=${f.rowsWithDays} ` +
          `rowsWithUsedDays=${f.rowsWithUsedDays} laterRowsWithCarry=${f.laterRowsWithCarry}`,
      );
    }

    console.info(
      `Totals: employees=${findings.length} rowsBeforeHire=${rowsBeforeHire} rowsWithDays=${rowsWithDays}`,
    );
    if (findings.length === 0) {
      console.info("No entitlement row of a year before the hire year found.");
    } else {
      console.info("This script writes nothing.");
    }

    return findings.length > 0 ? EXIT_FINDINGS : EXIT_OK;
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

/**
 * Audit tool - Issue #780.
 *
 * Since #780 a month for which no WorkSchedule is valid at its end carries no Soll in the live saldo
 * and in the Monatsabschluss (`contexts/working-time-account/month-contract.ts`); before, the live
 * chain charged the tenant-default Soll for it while the report rows showed none. This script lists,
 * per tenant, every person whose `hireDate` lies before the earliest `WorkSchedule.validFrom` (the
 * constellation), and the live-saldo delta the change causes for them. Persons with no contract at
 * all are not listed (no earliest validFrom to compare against).
 *
 * The delta is MEASURED, not re-derived: the same live computation runs twice, once normally and
 * once through a read-only Prisma view that answers every "is there a contract at all" probe with
 * "yes" (the pre-#780 behaviour: tenant-default fallback). Closed months are read verbatim in both
 * runs, so a person whose contract-less months are already closed shows delta 0.
 *
 * READ-ONLY. ZERO mutations. There is no write flag; `--confirm` / `--apply` are rejected.
 * Output contains ids and minutes only - no name, no employee number (DSGVO).
 *
 * Usage:
 *   DATABASE_URL=<dsn> pnpm --filter @clokr/api exec tsx \
 *     scripts/audit-780-hire-before-contract.ts ( --tenant-id <uuid> | --all-tenants ) [--help]
 *
 * Exit codes: 0 nobody listed; 1 error; 2 one or more persons listed.
 */
import { PrismaClient } from "@clokr/db";
import { PrismaPg } from "@prisma/adapter-pg";
import pg from "pg";
import { parseArgs } from "node:util";
import { pathToFileURL } from "node:url";
import { computeOvertimeBalanceBreakdown } from "../src/contexts/working-time-account";

export const EXIT_OK = 0;
export const EXIT_ERROR = 1;
export const EXIT_FINDINGS = 2;

export type CliArgs = { tenantId: string | null; allTenants: boolean; help: boolean };

export function parseCli(argv: string[]): CliArgs {
  const { values } = parseArgs({
    args: argv,
    options: {
      "tenant-id": { type: "string" },
      "all-tenants": { type: "boolean", default: false },
      help: { type: "boolean", default: false },
    },
    strict: true, // rejects any unknown flag, in particular --confirm / --apply
  });
  return {
    tenantId: values["tenant-id"] ?? null,
    allTenants: Boolean(values["all-tenants"]),
    help: Boolean(values.help),
  };
}

export const USAGE = `
Usage:
  DATABASE_URL=<dsn> pnpm --filter @clokr/api exec tsx \\
    scripts/audit-780-hire-before-contract.ts ( --tenant-id <uuid> | --all-tenants ) [--help]

READ-ONLY - lists persons whose hireDate lies before their earliest WorkSchedule.validFrom and the
live-saldo delta Issue #780 causes. Ids and minutes only.

Exit codes:
  0 - nobody listed
  1 - DATABASE_URL missing, bad CLI, or a DB connection/query failure
  2 - one or more persons listed
`;

export type Finding = { tenantId: string; employeeId: string; deltaMinutes: number };

export function formatFindingLine(f: Finding): string {
  return `employee tenantId=${f.tenantId} employeeId=${f.employeeId} deltaMinutes=${f.deltaMinutes}`;
}

/**
 * A read-only view of the client in which every "is any contract valid at this instant" probe
 * (`workSchedule.findFirst` with `select: { id: true }`, see `resolveMonthContract`) finds one - the
 * pre-#780 behaviour. Every other delegate and call is the real client's.
 */
export function withPre780ContractProbe(prisma: PrismaClient): PrismaClient {
  return new Proxy(prisma, {
    get(target, prop) {
      if (prop === "workSchedule") {
        const real = Reflect.get(target, prop, target) as PrismaClient["workSchedule"];
        return new Proxy(real, {
          get(t, p) {
            if (p === "findFirst") {
              return async (args: { select?: { id?: boolean } }) => {
                const row = await t.findFirst(args as never);
                return row === null && args?.select?.id === true ? { id: "pre-780-probe" } : row;
              };
            }
            return Reflect.get(t, p, t);
          },
        });
      }
      return Reflect.get(target, prop, target);
    },
  });
}

/**
 * Exported for unit-testability — pass a PrismaClient to inject a test connection (worker test DB
 * only); without one the CLI entrypoint below bootstraps its own connection from DATABASE_URL.
 */
export async function main(argv: string[], injectedPrisma?: PrismaClient): Promise<number> {
  const args = parseCli(argv);
  if (args.help) {
    console.info(USAGE);
    return EXIT_OK;
  }
  if ((!args.tenantId && !args.allTenants) || (args.tenantId && args.allTenants)) {
    throw new Error(
      "Tenant-Auswahl erforderlich: bitte --tenant-id <uuid> ODER --all-tenants angeben.",
    );
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

  // The live computation only reads `app.prisma` / `app.log` (same shim as audit-494/682).
  const log = {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    warn: (...a: any[]) => console.warn(...a),
    info: () => undefined,
  };
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const appNew: any = { prisma, log };
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const appOld: any = { prisma: withPre780ContractProbe(prisma), log };

  try {
    const tenantIds = args.allTenants
      ? (await prisma.tenant.findMany({ select: { id: true }, orderBy: { id: "asc" } })).map(
          (t) => t.id,
        )
      : [args.tenantId!];

    const schedules = await prisma.workSchedule.groupBy({
      by: ["employeeId"],
      _min: { validFrom: true },
      where: { employee: { tenantId: { in: tenantIds } } },
    });
    const employees = await prisma.employee.findMany({
      where: { id: { in: schedules.map((s) => s.employeeId) } },
      orderBy: { id: "asc" },
      select: { id: true, tenantId: true, hireDate: true },
    });
    const firstValidFrom = new Map(schedules.map((s) => [s.employeeId, s._min.validFrom]));

    let listed = 0;
    let exempt = 0;
    let candidates = 0;
    for (const employee of employees) {
      const first = firstValidFrom.get(employee.id);
      if (!first || !(employee.hireDate < first)) continue;
      candidates++;
      const after = await computeOvertimeBalanceBreakdown(appNew, employee.id);
      const before = await computeOvertimeBalanceBreakdown(appOld, employee.id);
      if (after === null || before === null) {
        exempt++;
        continue;
      }
      const deltaMinutes = Math.round(after.totalHours * 60) - Math.round(before.totalHours * 60);
      listed++;
      console.info(
        formatFindingLine({ tenantId: employee.tenantId, employeeId: employee.id, deltaMinutes }),
      );
    }

    console.info(
      `\nSummary: ${listed} person(s) with hireDate before the first contract in ` +
        `${tenantIds.length} tenant(s) (${candidates} found, ${exempt} exempt). ` +
        `deltaMinutes 0 = the contract-less months are already closed. This script writes nothing.`,
    );
    return listed > 0 ? EXIT_FINDINGS : EXIT_OK;
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

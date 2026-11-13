/**
 * Audit tool - Issue #473.
 *
 * A MONTHLY_HOURS contract has no weekly-hours Soll, so the individual daily Soll that is the
 * default credit of a Berufsschultag (§ 15 Abs. 2 BBiG) used to be 0 and a school day credited no
 * worked time. Since #473 the day is credited at the Ø-day value (monthlyHours x 60 / contractual
 * workdays of the full month) to worked minutes only (Soll untouched, "a day reduces Soll exactly
 * once"). Closed months are never recalculated, so months closed BEFORE the rule keep their stored
 * figures. This script lists that Bestand so the owner can decide about deliberate, audited
 * correction bookings (unlock + re-close).
 *
 * What it lists: per non-superseded MONTHLY SaldoSnapshot whose contract valid at the month
 * midpoint is MONTHLY_HOURS with monthlyHours > 0 and whose month holds at least one non-deleted
 * VOCATIONAL_SCHOOL absence day on a contractual workday: month, number of such days
 * (`bsWorkdays`), the credit the rule now gives (`creditNowMinutes`, sum of the Ø-day values)
 * and the stored balance. Explicit bsSlot* overrides are not evaluated here; the figure is the
 * default-rule credit.
 *
 * READ-ONLY. ZERO mutations, no write flag. Output contains ids and minutes only (DSGVO).
 *
 * Usage:
 *   DATABASE_URL=<dsn> pnpm --filter @clokr/api exec tsx scripts/audit-473-azubi-monthly-bs.ts \
 *     ( --tenant-id <uuid> | --all-tenants ) [--help]
 *
 * Exit codes: 0 no finding, 1 error, 2 findings (correction only via unlock + re-close).
 */
import { PrismaClient } from "@clokr/db";
import { PrismaPg } from "@prisma/adapter-pg";
import pg from "pg";
import { parseArgs } from "node:util";
import { pathToFileURL } from "node:url";
import {
  getTenantTimezone,
  monthRangeUtc,
  dateStrInTz,
  calcMonthlyHoursDayMinutesTz,
} from "../src/contexts/working-time-account";

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
  DATABASE_URL=<dsn> pnpm --filter @clokr/api exec tsx scripts/audit-473-azubi-monthly-bs.ts \\
    ( --tenant-id <uuid> | --all-tenants ) [--help]

READ-ONLY - lists closed MONTHLY snapshots of MONTHLY_HOURS contracts (monthlyHours > 0) whose month
holds Berufsschule workdays (Issue #473). Correction only via unlock + re-close.
`;

export type Finding = {
  tenantId: string;
  employeeId: string;
  snapshotId: string;
  month: string; // YYYY-MM
  bsWorkdays: number;
  creditNowMinutes: number;
  storedBalanceMinutes: number;
  closedAt: string; // ISO instant of the close that wrote the row
};

export function formatFindingLine(f: Finding): string {
  return (
    `finding tenantId=${f.tenantId} employeeId=${f.employeeId} snapshotId=${f.snapshotId} ` +
    `month=${f.month} bsWorkdays=${f.bsWorkdays} creditNowMinutes=${f.creditNowMinutes} ` +
    `storedBalanceMinutes=${f.storedBalanceMinutes} closedAt=${f.closedAt}`
  );
}

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
    prisma = new PrismaClient({ adapter: new PrismaPg(pool as any) });
  }

  try {
    const tenants = args.allTenants
      ? await prisma.tenant.findMany({ select: { id: true } })
      : [{ id: args.tenantId! }];
    let findingCount = 0;

    for (const tenant of tenants) {
      const tz = await getTenantTimezone(prisma, tenant.id);
      const tenantConfig = await prisma.tenantConfig.findFirst({
        where: { tenantId: tenant.id },
        select: { defaultWorkDays: true },
      });
      const contracts = await prisma.workSchedule.findMany({
        where: { employee: { tenantId: tenant.id }, type: "MONTHLY_HOURS" },
        select: { employeeId: true },
      });
      const employeeIds = [...new Set(contracts.map((c) => c.employeeId))];
      if (employeeIds.length === 0) continue;

      const snapshots = await prisma.saldoSnapshot.findMany({
        where: {
          periodType: "MONTHLY",
          superseded: false,
          employeeId: { in: employeeIds },
          employee: { tenantId: tenant.id },
        },
        orderBy: [{ employeeId: "asc" }, { periodStart: "asc" }],
        select: {
          id: true,
          employeeId: true,
          periodStart: true,
          periodEnd: true,
          balanceMinutes: true,
          closedAt: true,
        },
      });

      for (const snap of snapshots) {
        const mid = new Date((snap.periodStart.getTime() + snap.periodEnd.getTime()) / 2);
        const year = mid.getUTCFullYear();
        const monthNo = mid.getUTCMonth() + 1;
        const { start: monthStart, end: monthEnd } = monthRangeUtc(year, monthNo, tz);
        const midMonth = new Date((monthStart.getTime() + monthEnd.getTime()) / 2);

        const schedule = await prisma.workSchedule.findFirst({
          where: { employeeId: snap.employeeId, validFrom: { lte: midMonth } },
          orderBy: { validFrom: "desc" },
        });
        if (
          !schedule ||
          schedule.type !== "MONTHLY_HOURS" ||
          !(Number(schedule.monthlyHours) > 0)
        ) {
          continue;
        }

        const absences = await prisma.absence.findMany({
          where: {
            employeeId: snap.employeeId,
            employee: { tenantId: tenant.id },
            type: "VOCATIONAL_SCHOOL",
            deletedAt: null,
            startDate: { lte: monthEnd },
            endDate: { gte: monthStart },
          },
          select: { startDate: true, endDate: true },
        });
        const monthKey = `${year}-${String(monthNo).padStart(2, "0")}`;
        const days = new Set<string>();
        for (const ab of absences) {
          for (
            let cur = new Date(ab.startDate.getTime());
            cur <= ab.endDate;
            cur = new Date(cur.getTime() + 24 * 60 * 60 * 1000)
          ) {
            const ds = dateStrInTz(cur, tz);
            if (ds.startsWith(monthKey)) days.add(ds);
          }
        }
        let credit = 0;
        let workdays = 0;
        for (const ds of days) {
          const v = calcMonthlyHoursDayMinutesTz(
            schedule as unknown as Record<string, unknown>,
            ds,
            tz,
            tenantConfig?.defaultWorkDays,
          );
          if (v > 0) {
            workdays++;
            credit += v;
          }
        }
        if (workdays === 0) continue;
        findingCount++;
        console.info(
          formatFindingLine({
            tenantId: tenant.id,
            employeeId: snap.employeeId,
            snapshotId: snap.id,
            month: monthKey,
            bsWorkdays: workdays,
            creditNowMinutes: credit,
            storedBalanceMinutes: snap.balanceMinutes,
            closedAt: snap.closedAt.toISOString(),
          }),
        );
      }
    }
    console.info(`summary findings=${findingCount} readOnly=true`);
    return findingCount > 0 ? EXIT_FINDINGS : EXIT_OK;
  } finally {
    if (pool) await pool.end();
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main(process.argv.slice(2))
    .then((code) => process.exit(code))
    .catch((err) => {
      console.error(err instanceof Error ? err.message : err);
      process.exit(EXIT_ERROR);
    });
}

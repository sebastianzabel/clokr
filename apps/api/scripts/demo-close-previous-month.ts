/**
 * demo-close-previous-month.ts — Issue #595 (D-05, P-06) DEVELOPMENT tool for the demo tenant.
 *
 * `packages/db/src/seed-demo.ts` no longer fabricates a closed month: it writes the previous
 * month's entries unlocked and, one month earlier, a zero pre-tracking snapshot per demo employee
 * (the chain head). This script closes the previous month with Clokr's REAL closer, so the demo
 * shows the Soll/Ist/Saldo the saldo kernel computes, stored in the convention the closer writes
 * (TZ-converted `periodStart`).
 *
 * What it does:
 *   1. Resolves the demo tenant by slug and takes its time zone.
 *   2. Picks the chain-head employees: the previous month is open and the month before it is
 *      closed (the zero row). Nobody else is touched.
 *   3. Records `computeMonthReportFigures` of the previous month per head (open month, kernel).
 *   4. Hands those employees to the exported core of `backfill-month-snapshots.ts`
 *      (`main(app, { apply, tenantId, employeeIds, until })`), which closes the month through the
 *      shared `closeEmployeeMonth` core and writes the BACKFILL audit rows.
 *   5. With `--apply`, records the figures again (snapshot, confirmed) and compares them: the
 *      stored figures must be the kernel's. Any difference is a mismatch and exit code 3.
 *
 * What it does NOT do: it re-implements no closing rule (the backfill core closes), reads no
 * employee data beyond ids and minutes, and deletes nothing. The running API's 06:00 auto-close
 * would close the same month the next morning; this tool only makes the demo show it right away.
 *
 * Usage (dry run first, then the write; the database name must be spelled out):
 *   DATABASE_URL=postgresql://.../<db> pnpm --filter @clokr/api exec tsx \
 *     scripts/demo-close-previous-month.ts [--apply] --confirm-database <db>
 *
 * Guards (T-595-14): refuses NODE_ENV=production; `--confirm-database` must equal the database
 * the connection reports; only chain-head employees of the demo tenant are handed on.
 *
 * Exit codes: 0 success, 1 usage/guard/runtime error, 2 nothing to close (no demo tenant or no
 * chain-head employee), 3 a before/after mismatch.
 */
import type { FastifyInstance } from "fastify";
import {
  computeMonthReportFigures,
  dateStrInTz,
  getTenantTimezone,
  isMonthClosed,
  monthRangeUtc,
} from "../src/contexts/working-time-account";
import { main as backfillMain, type BackfillSummary } from "./backfill-month-snapshots";

/** Equal to `TENANT_SLUG` in `packages/db/src/seed-demo.ts`; pinned by demo-month-bounds-595.test.ts. */
export const DEMO_TENANT_SLUG = "demo-clokr";

/** Refuse a wrong target before anything else happens. */
export function assertDemoCloseTarget(args: {
  nodeEnv: string | undefined;
  confirmDatabase: string | undefined;
  connectedDatabase: string;
}): void {
  if (args.nodeEnv === "production") {
    throw new Error("demo-close-previous-month: refusing to run with NODE_ENV=production");
  }
  if (!args.confirmDatabase) {
    throw new Error(
      "demo-close-previous-month: --confirm-database <name> is required (the database this run may write)",
    );
  }
  if (args.confirmDatabase !== args.connectedDatabase) {
    throw new Error(
      `demo-close-previous-month: --confirm-database "${args.confirmDatabase}" does not match the connected database "${args.connectedDatabase}"; refusing`,
    );
  }
}

export type DemoCloseFigures = {
  workedMinutes: number;
  expectedMinutes: number;
  balanceMinutes: number;
  confirmed: boolean;
};

export type DemoCloseRow = {
  employeeId: string;
  /** Kernel figures of the still-open month. */
  before: DemoCloseFigures;
  /** Figures after the close (apply only). */
  after: DemoCloseFigures | null;
  /** `null` until the close ran; then whether after is confirmed and equals before. */
  matches: boolean | null;
};

export type DemoCloseSummary = {
  apply: boolean;
  tenantFound: boolean;
  /** The month this run closes (the tenant-local previous month). */
  month: { year: number; month: number } | null;
  rows: DemoCloseRow[];
  mismatches: number;
  /** The backfill core's own summary; `null` when nothing was handed to it. */
  backfill: BackfillSummary | null;
};

function figuresOf(f: {
  workedMinutes: number;
  expectedMinutes: number;
  balanceMinutes: number;
  confirmed: boolean;
}): DemoCloseFigures {
  return {
    workedMinutes: f.workedMinutes,
    expectedMinutes: f.expectedMinutes,
    balanceMinutes: f.balanceMinutes,
    confirmed: f.confirmed,
  };
}

/** The month before `{year, month}` (1-based). */
function monthBefore(year: number, month: number): { year: number; month: number } {
  return month === 1 ? { year: year - 1, month: 12 } : { year, month: month - 1 };
}

export async function runDemoClose(
  app: FastifyInstance,
  opts: { tenantSlug: string; apply: boolean },
): Promise<DemoCloseSummary> {
  const summary: DemoCloseSummary = {
    apply: opts.apply,
    tenantFound: false,
    month: null,
    rows: [],
    mismatches: 0,
    backfill: null,
  };

  const tenant = await app.prisma.tenant.findUnique({
    where: { slug: opts.tenantSlug },
    select: { id: true },
  });
  if (!tenant) return summary;
  summary.tenantFound = true;

  const tz = await getTenantTimezone(app.prisma, tenant.id);
  // The previous month exactly like the auto-close computes it: from the tenant-local today.
  const [todayYear, todayMonth] = dateStrInTz(new Date(), tz)
    .split("-")
    .map((part) => parseInt(part, 10)) as [number, number];
  const m1 = monthBefore(todayYear, todayMonth);
  const m2 = monthBefore(m1.year, m1.month);
  summary.month = m1;
  const m1Start = monthRangeUtc(m1.year, m1.month, tz).start;
  const m2Start = monthRangeUtc(m2.year, m2.month, tz).start;

  // Chain heads: the month before the previous one is closed (the zero pre-tracking row), the
  // previous one is not. Everyone else — employees without any snapshot included — is left alone.
  const candidates = await app.prisma.employee.findMany({
    where: { tenantId: tenant.id, user: { isActive: true }, isTimeTrackingExempt: false },
    select: { id: true },
    orderBy: { id: "asc" },
  });
  const heads: string[] = [];
  for (const candidate of candidates) {
    const m2Closed = await isMonthClosed(app.prisma, candidate.id, tenant.id, m2Start);
    if (!m2Closed) continue;
    const m1Closed = await isMonthClosed(app.prisma, candidate.id, tenant.id, m1Start);
    if (m1Closed) continue;
    heads.push(candidate.id);
  }

  // Never hand an empty list on: the backfill core reads "no employee ids" as "every employee".
  if (heads.length === 0) return summary;

  for (const employeeId of heads) {
    const before = await computeMonthReportFigures(app, employeeId, m1.year, m1.month);
    summary.rows.push({ employeeId, before: figuresOf(before), after: null, matches: null });
  }

  summary.backfill = await backfillMain(app, {
    apply: opts.apply,
    tenantId: tenant.id,
    employeeIds: heads,
    until: m1,
  });

  if (opts.apply) {
    for (const row of summary.rows) {
      const after = await computeMonthReportFigures(app, row.employeeId, m1.year, m1.month);
      row.after = figuresOf(after);
      row.matches =
        row.after.confirmed &&
        row.after.workedMinutes === row.before.workedMinutes &&
        row.after.expectedMinutes === row.before.expectedMinutes &&
        row.after.balanceMinutes === row.before.balanceMinutes;
      if (!row.matches) summary.mismatches++;
    }
  }

  return summary;
}

// ── CLI ──────────────────────────────────────────────────────────────────────

const isCli =
  process.argv[1] !== undefined && /demo-close-previous-month\.[tj]s$/.test(process.argv[1]);

if (isCli) {
  (async () => {
    const { parseArgs } = await import("node:util");
    const { values } = parseArgs({
      args: process.argv.slice(2),
      options: {
        apply: { type: "boolean", default: false },
        "confirm-database": { type: "string" },
      },
      strict: true,
    });

    const databaseUrl = process.env.DATABASE_URL;
    if (!databaseUrl) {
      console.error("DATABASE_URL is required");
      process.exit(1);
    }

    // The guard runs before the app (and with it any plugin) exists.
    const pg = (await import("pg")).default;
    const probe = new pg.Pool({ connectionString: databaseUrl, max: 1 });
    let connectedDatabase: string;
    try {
      const result = await probe.query<{ current_database: string }>("SELECT current_database()");
      connectedDatabase = result.rows[0]?.current_database ?? "";
    } finally {
      await probe.end();
    }
    try {
      assertDemoCloseTarget({
        nodeEnv: process.env.NODE_ENV,
        confirmDatabase: values["confirm-database"],
        connectedDatabase,
      });
    } catch (err) {
      console.error((err as Error).message);
      process.exit(1);
    }

    const { buildApp } = await import("../src/app");
    const app = await buildApp();
    await app.ready();

    let exitCode = 0;
    try {
      const summary = await runDemoClose(app, {
        tenantSlug: DEMO_TENANT_SLUG,
        apply: Boolean(values.apply),
      });
      console.info(
        `demo-close-previous-month: database ${connectedDatabase}, ${summary.apply ? "APPLY" : "dry run"}`,
      );
      if (!summary.tenantFound) {
        console.info(`no tenant with slug "${DEMO_TENANT_SLUG}"`);
        exitCode = 2;
      } else if (summary.rows.length === 0) {
        console.info("no chain-head employee: nothing left to close");
        exitCode = 2;
      } else {
        const month = summary.month!;
        console.info(
          `month ${month.year}-${String(month.month).padStart(2, "0")}, ${summary.rows.length} employee(s)`,
        );
        for (const row of summary.rows) {
          const fmt = (f: DemoCloseFigures | null) =>
            f === null
              ? "-"
              : `worked ${f.workedMinutes} expected ${f.expectedMinutes} balance ${f.balanceMinutes} ${f.confirmed ? "confirmed" : "open"}`;
          console.info(
            `  ${row.employeeId}: before [${fmt(row.before)}] after [${fmt(row.after)}] ${
              row.matches === null ? "" : row.matches ? "MATCH" : "MISMATCH"
            }`,
          );
        }
        if (summary.mismatches > 0) {
          console.error(`${summary.mismatches} employee(s) with before/after mismatch`);
          exitCode = 3;
        }
      }
    } catch (err) {
      console.error((err as Error).message ?? err);
      exitCode = 1;
    } finally {
      await app.close();
    }
    process.exit(exitCode);
  })();
}

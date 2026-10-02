/**
 * Audit tool — Issue #448 (D-06).
 *
 * Plans 448-01..03 make every NEW leave-day price BS-free (`resolveLeaveDays()`'s D-02
 * exclusion) and every saldo close BS-aware (D-03, `close-employee-month.ts`); plan 448-02
 * corrects a Berufsschultag created LATER over an already PENDING/APPROVED/
 * CANCELLATION_REQUESTED VACATION request in the same transaction as the BS write
 * (`correctLeaveForNewVocationalSchoolDay`, D-04). This script lists the Bestand: every
 * VOCATIONAL_SCHOOL `Absence` overlapping a VACATION request's date range, whether or not the
 * automatic correction already ran for it, so whoever owns payroll sees the current state at a
 * glance and can confirm nothing needs a manual correction booking.
 *
 * Measured on prod (01.10.2026, per the owner's implementation-decisions comment on Issue #448):
 * 0 overlaps.
 *
 * READ-ONLY. ZERO mutations — there is no opt-in write/correction flag anywhere in this file,
 * and none may ever be added (same reasoning as `audit-multi-day-half-day-leave.ts`'s and
 * `dry-run-429-leave-contract-days.ts`'s own D-15-cited rationale): correcting a finding here —
 * when the automatic correction (plan 02, D-04) has not already run for it — happens only
 * through the next BS write running that correction itself, or through "Antrag korrigieren"
 * after owner approval, never as a side effect of running this script.
 *
 * Scope: every non-deleted VACATION `LeaveRequest` (status PENDING or in
 * `EFFECTIVE_LEAVE_STATUSES` — the SAME status set `correctLeaveForNewVocationalSchoolDay`
 * re-prices, D-04) whose date range overlaps at least one non-deleted `VOCATIONAL_SCHOOL`
 * `Absence` of the same employee (either source, PATTERN or MANUAL — D-01). Each such request is
 * re-priced through `resolveLeaveDays()` — the SAME pricing kernel plans 01/02 use
 * (`mode: "request"`, `leaveTypeCode: "VACATION"`, `excludeRequestId` set to the request's own
 * id, never a second day counter) — and compared against its stored `days` (2-decimal). Every
 * overlapping BS Absence's own tenant-TZ month is checked via the canonical `isMonthClosed()`; a
 * locked month is a finding REGARDLESS of whether the stored price still matches, mirroring
 * plan 02's own closed-month branch (the owner must know a correction booking may be needed
 * there even if the numbers happen to already agree).
 *
 * Output contains ids only — no employee name, no employee number (DSGVO), following
 * `audit-saldo-chain-integrity.ts`'s / `dry-run-429-leave-contract-days.ts`'s convention.
 *
 * Usage:
 *   DATABASE_URL=<dsn> pnpm --filter @clokr/api exec tsx \
 *     scripts/audit-bs-leave-overlap.ts \
 *     ( --tenant-id <uuid> | --all-tenants ) \
 *     [--help]
 *
 * Exit codes:
 *   0 — no overlap finding for the given scope
 *   1 — usage error (neither, or both, of --tenant-id/--all-tenants given), or DATABASE_URL
 *       missing / a DB connection/query failure
 *   2 — one or more findings (the stored price differs from the re-priced BS-free price, or a
 *       BS date lies in a closed month) — review manually; correction runs only through the
 *       existing paths named above, never this script
 */
import { PrismaClient } from "@clokr/db";
import { PrismaPg } from "@prisma/adapter-pg";
import pg from "pg";
import { parseArgs } from "node:util";
import { pathToFileURL } from "node:url";
import {
  EFFECTIVE_LEAVE_STATUSES,
  getAbsencesOverlapping,
  getHolidayMap,
  resolveLeaveDays,
} from "../src/contexts/absence";
import {
  getTenantTimezone,
  isMonthClosed,
  monthRangeUtc,
} from "../src/contexts/working-time-account";
import type { EmployeeScope } from "../src/contexts/platform";

// ── Exit codes ──────────────────────────────────────────────────────────────
export const EXIT_OK = 0;
export const EXIT_ERROR = 1;
export const EXIT_FINDINGS = 2;

// ── CLI parsing ───────────────────────────────────────────────────────────────
export type CliArgs = {
  tenantId: string | null;
  allTenants: boolean;
  help: boolean;
};

export function parseCliArgs(argv: string[]): CliArgs {
  const { values } = parseArgs({
    args: argv,
    options: {
      "tenant-id": { type: "string" },
      "all-tenants": { type: "boolean", default: false },
      help: { type: "boolean", default: false },
    },
    strict: true, // rejects any unknown flag — no opt-in mutation flag is ever accepted here
  });

  return {
    tenantId: values["tenant-id"] ?? null,
    allTenants: Boolean(values["all-tenants"]),
    help: Boolean(values.help),
  };
}

const USAGE = `
Usage:
  DATABASE_URL=<dsn> pnpm --filter @clokr/api exec tsx \\
    scripts/audit-bs-leave-overlap.ts \\
    ( --tenant-id <uuid> | --all-tenants ) \\
    [--help]

READ-ONLY (Issue #448, D-06) — lists every non-deleted PENDING/APPROVED/CANCELLATION_REQUESTED
VACATION LeaveRequest whose range overlaps a VOCATIONAL_SCHOOL Absence, with the stored vs.
BS-free re-priced day count and the locked-month flag. No write/correction flag exists.

Exit codes:
  0 - no finding for the given scope
  1 - usage error, or DATABASE_URL missing / a DB connection/query failure
  2 - one or more findings
`;

// ── Finding shape + pure helpers (DB-free, unit-testable) ───────────────────

export type OverlapFinding = {
  leaveRequestId: string;
  employeeId: string;
  tenantId: string;
  bsAbsenceIds: string[];
  storedDays: number;
  repricedDays: number;
  locked: boolean;
};

/** Finding = the 2-decimal-rounded re-priced total differs from the stored total, OR any
 * overlapping BS date's month is locked (D-06) — a locked month is always a finding, even when
 * the numbers happen to already agree, mirroring plan 02's own closed-month branch. */
export function classifyOverlap(args: {
  storedDays: number;
  repricedDays: number;
  locked: boolean;
}): boolean {
  const storedRounded = Math.round(args.storedDays * 100);
  const repricedRounded = Math.round(args.repricedDays * 100);
  return args.locked || storedRounded !== repricedRounded;
}

/** Ids and numbers only — no name, no employee number (DSGVO). */
export function renderReport(f: OverlapFinding): string {
  return (
    `leaveRequestId=${f.leaveRequestId} employeeId=${f.employeeId} tenantId=${f.tenantId} ` +
    `bsAbsenceIds=${f.bsAbsenceIds.join(",")} stored=${f.storedDays} repriced=${f.repricedDays} ` +
    `locked=${f.locked}`
  );
}

// ── Main entry point ─────────────────────────────────────────────────────────

/**
 * Exported for unit-testability — pass a PrismaClient to inject a test connection (run against
 * the worker test DB only); without one this bootstraps its own connection from DATABASE_URL.
 * Takes an already-parsed `CliArgs` so a test can exercise the usage-validation branch without
 * going through argv parsing at all.
 */
export async function run(args: CliArgs, injectedPrisma?: PrismaClient): Promise<number> {
  if (args.help) {
    console.info(USAGE);
    return EXIT_OK;
  }

  const exactlyOne =
    (args.tenantId !== null && !args.allTenants) || (args.tenantId === null && args.allTenants);
  if (!exactlyOne) {
    console.error(
      "Usage-Fehler: bitte genau einen der beiden Parameter angeben: --tenant-id <uuid> ODER --all-tenants.",
    );
    console.error(USAGE);
    return EXIT_ERROR;
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
    const tenants = args.allTenants
      ? await prisma.tenant.findMany({ select: { id: true } })
      : [{ id: args.tenantId! }];

    const findings: OverlapFinding[] = [];
    const tzByTenant = new Map<string, string>();

    for (const t of tenants) {
      if (!tzByTenant.has(t.id)) {
        tzByTenant.set(t.id, await getTenantTimezone(prisma, t.id));
      }
      const tz = tzByTenant.get(t.id)!;

      // Scope: VACATION requests only (selection by `leaveType.code`, never by name — CLAUDE.md),
      // status PENDING or EFFECTIVE_LEAVE_STATUSES (the same set the D-04 correction re-prices).
      const requests = await prisma.leaveRequest.findMany({
        where: {
          deletedAt: null,
          employee: { tenantId: t.id },
          status: { in: ["PENDING", ...EFFECTIVE_LEAVE_STATUSES] },
          leaveType: { code: "VACATION" },
        },
        select: {
          id: true,
          employeeId: true,
          startDate: true,
          endDate: true,
          halfDay: true,
          days: true,
        },
        orderBy: [{ employeeId: "asc" }, { startDate: "asc" }],
      });

      for (const req of requests) {
        const scope: EmployeeScope = {
          kind: "employee",
          employeeId: req.employeeId,
          tenantId: t.id,
        };
        const overlapping = await getAbsencesOverlapping(prisma, scope, req.startDate, req.endDate);
        const bsAbsences = overlapping.filter((a) => a.type === "VOCATIONAL_SCHOOL");
        if (bsAbsences.length === 0) continue;

        // Locked flag: any overlapping BS absence's own tenant-TZ month is closed (D-06) —
        // mirrors correctLeaveForNewVocationalSchoolDay's own per-date closed-month gate.
        let locked = false;
        for (const bs of bsAbsences) {
          const { start: bsMonthStart } = monthRangeUtc(
            bs.startDate.getUTCFullYear(),
            bs.startDate.getUTCMonth() + 1,
            tz,
          );
          if (await isMonthClosed(prisma, req.employeeId, t.id, bsMonthStart)) {
            locked = true;
            break;
          }
        }

        const holidayMap = await getHolidayMap(
          prisma,
          t.id,
          req.employeeId,
          req.startDate,
          req.endDate,
        );
        const holidays = new Set(holidayMap.keys());
        const resolved = await resolveLeaveDays(
          prisma,
          req.employeeId,
          t.id,
          req.startDate,
          req.endDate,
          req.halfDay,
          holidays,
          { mode: "request", leaveTypeCode: "VACATION", excludeRequestId: req.id },
        );

        const storedDays = Math.round(Number(req.days) * 100) / 100;
        const repricedDays = Math.round(resolved.days * 100) / 100;

        if (!classifyOverlap({ storedDays, repricedDays, locked })) continue;

        const finding: OverlapFinding = {
          leaveRequestId: req.id,
          employeeId: req.employeeId,
          tenantId: t.id,
          bsAbsenceIds: bsAbsences.map((a) => a.id),
          storedDays,
          repricedDays,
          locked,
        };
        findings.push(finding);
        console.info(renderReport(finding));
      }
    }

    if (findings.length === 0) {
      console.info("No Berufsschultag/Urlaub overlap finding for the given scope.");
    } else {
      console.info(
        `\nSummary: ${findings.length} finding(s) across ${tenants.length} tenant(s). ` +
          "Correction runs only through the next BS write's own correction path, or " +
          '"Antrag korrigieren" after owner approval — this script writes nothing.',
      );
    }

    return findings.length > 0 ? EXIT_FINDINGS : EXIT_OK;
  } finally {
    if (!injectedPrisma) {
      await prisma.$disconnect();
      await pool?.end();
    }
  }
}

async function main(): Promise<number> {
  const args = parseCliArgs(process.argv.slice(2));
  return run(args);
}

// Run-guard: only bootstrap the DB + execute when invoked as a script, so importing the module
// for unit tests is side-effect-free (no connection, no process.exit).
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  void main()
    .then((code) => {
      process.exitCode = code;
    })
    .catch((err: unknown) => {
      console.error(err instanceof Error ? err.message : String(err));
      process.exitCode = EXIT_ERROR;
    });
}

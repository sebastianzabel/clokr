/**
 * Audit tool — Issue #494 (R6, D-06, D-13).
 *
 * Issue #494 widens the track-only rule: a MONTHLY_HOURS contract WITHOUT monthly hours behaves
 * exactly like an explicit TRACK_ONLY contract — the Monatsabschluss stores `carryOver` 0 and the
 * live saldo shows 0 (`isTrackOnlySchedule`, `contexts/working-time-account/track-only-schedule.ts`).
 * Closed months are never recalculated, so months that were closed BEFORE the rule still carry a
 * stored, non-zero `carryOver`. This script lists that Bestand so the owner can decide about
 * deliberate, audited correction bookings.
 *
 * What it lists: per employee, every non-superseded MONTHLY `SaldoSnapshot` whose contract valid
 * at the month midpoint is track-only (same predicate, same contract resolution as every close
 * path) AND whose stored `carryOver` is not 0. Per finding: snapshotId, month, stored carry,
 * balance, locked flag, overtimeMode, monthlyHours and a reason — `NO_TARGET` (no monthly hours)
 * or `TRACK_ONLY_MODE` (explicit mode; D-13). The reason is a display label read from the stored
 * field AFTER the predicate decided; it is not a second copy of the rule.
 *
 * `OPENING_BALANCE` (review WR-02): a snapshot that carries a documented opening balance — the
 * bridge shape of `isBridgeSnapshot()` (single source of truth, `saldo-snapshot-cleanup.ts`) or a
 * month holding an active `OpeningBalance` row — is listed under that distinct reason and is NOT a
 * candidate for unlock + re-close: re-closing it under a track-only contract writes carry 0 and
 * destroys the opening balance. Such rows need a deliberate, separate decision.
 *
 * Per affected employee one summary line: `lastActiveCarryOver` (the stored confirmed carry — the
 * live figure BEFORE the rule; a faithful pre-rule live figure cannot be recomputed without the
 * pre-rule code), `liveAfterMinutes` (the live figure UNDER the rule, the same computation
 * `GET /api/v1/overtime/:id` uses), `todayContractAffected`, `laterContractWithTarget` (a later
 * contract that is NOT track-only would transplant the stale carry; `priority=HIGH`) and
 * `yearlyNonZeroCarry` (Jahresübertrag exposure).
 *
 * READ-ONLY. ZERO mutations. There is no write/correction flag anywhere in this file, and none
 * may ever be added: a correction of a closed month runs only through the existing unlock
 * (mandatory reason, UNLOCK audit entry) followed by a re-close — never through this script.
 * Closed months are never recalculated here.
 *
 * Output contains ids only — no employee name, no employee number (DSGVO). Full, untruncated
 * UUIDs: the owner must be able to locate each row directly.
 *
 * Usage:
 *   DATABASE_URL=<dsn> pnpm --filter @clokr/api exec tsx \
 *     scripts/audit-494-track-only-carry.ts \
 *     ( --tenant-id <uuid> | --all-tenants ) \
 *     [--help]
 *
 * Exit codes:
 *   0 — no stored carry-over of a track-only month found for the given scope
 *   1 — DATABASE_URL missing, bad CLI, or a DB connection/query failure
 *   2 — one or more findings (review manually; correction only via unlock + re-close)
 */
import { PrismaClient } from "@clokr/db";
import { PrismaPg } from "@prisma/adapter-pg";
import pg from "pg";
import { parseArgs } from "node:util";
import { pathToFileURL } from "node:url";
import {
  getTenantTimezone,
  monthRangeUtc,
  isSnapshotLocked,
  getConfirmedCarryOver,
  computeOvertimeBalanceBreakdown,
} from "../src/contexts/working-time-account";
import {
  isTrackOnlySchedule,
  monthLabelFromPeriodEnd,
} from "../src/contexts/working-time-account/saldo-chain-integrity";
import { isBridgeSnapshot } from "../src/contexts/working-time-account/saldo-snapshot-cleanup";
import { getEffectiveSchedule } from "../src/contexts/time-tracking";

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
    scripts/audit-494-track-only-carry.ts \\
    ( --tenant-id <uuid> | --all-tenants ) \\
    [--help]

READ-ONLY — lists every non-superseded closed MONTHLY snapshot whose contract is track-only
(MONTHLY_HOURS without monthly hours, or explicit TRACK_ONLY) and whose stored carry-over is not 0
(Issue #494). No write/correction flag exists. Correction only via unlock + re-close.

Rows with reason=OPENING_BALANCE (bridge-shaped snapshot or a month with an active OpeningBalance)
must NOT be unlocked and re-closed — a re-close under a track-only contract writes carry 0 and
destroys the opening balance. Decide those separately.

priority=HIGH when a later contract with a target would inherit the stale carry
(priorityReason=LATER_CONTRACT_WITH_TARGET) or when today's contract is affected and the stored
carry is positive (priorityReason=BOOKABLE_LEGACY_CARRY — the Ueberstundenausgleich booking gate
still reads the stored carry while the live saldo shows 0).

Exit codes:
  0 — no finding for the given scope
  1 — DATABASE_URL missing, bad CLI, or a DB connection/query failure
  2 — one or more findings (correction only via unlock + re-close)
`;

// ── Output shapes ─────────────────────────────────────────────────────────────
export type FindingReason = "NO_TARGET" | "TRACK_ONLY_MODE" | "OPENING_BALANCE";

export type PriorityReason = "LATER_CONTRACT_WITH_TARGET" | "BOOKABLE_LEGACY_CARRY";

export type Finding = {
  tenantId: string;
  employeeId: string;
  snapshotId: string;
  month: string; // YYYY-MM
  storedCarryOver: number;
  balanceMinutes: number;
  locked: boolean;
  overtimeMode: string;
  monthlyHours: number | null;
  reason: FindingReason;
};

export type EmployeeSummary = {
  tenantId: string;
  employeeId: string;
  findings: number;
  lastActiveCarryOver: number;
  liveAfterMinutes: number | "exempt";
  todayContractAffected: boolean;
  laterContractWithTarget: boolean;
  priority: "HIGH" | "normal";
  /** Why the employee is HIGH (both can apply); empty for normal priority. */
  priorityReasons: PriorityReason[];
  yearlyNonZeroCarry: number;
  openingBalanceFindings: number;
};

/** Full UUIDs — DSGVO-safe (no name, no employee number), but locatable by the owner. */
export function formatFindingLine(f: Finding): string {
  return (
    `finding tenantId=${f.tenantId} employeeId=${f.employeeId} snapshotId=${f.snapshotId} ` +
    `month=${f.month} storedCarryOver=${f.storedCarryOver} balanceMinutes=${f.balanceMinutes} ` +
    `locked=${f.locked} overtimeMode=${f.overtimeMode} monthlyHours=${f.monthlyHours} ` +
    `reason=${f.reason}`
  );
}

export function formatEmployeeLine(s: EmployeeSummary): string {
  return (
    `employee tenantId=${s.tenantId} employeeId=${s.employeeId} findings=${s.findings} ` +
    `lastActiveCarryOver=${s.lastActiveCarryOver} liveAfterMinutes=${s.liveAfterMinutes} ` +
    `todayContractAffected=${s.todayContractAffected} ` +
    `laterContractWithTarget=${s.laterContractWithTarget} priority=${s.priority} ` +
    `priorityReason=${s.priorityReasons.length > 0 ? s.priorityReasons.join(",") : "none"} ` +
    `yearlyNonZeroCarry=${s.yearlyNonZeroCarry} openingBalanceFindings=${s.openingBalanceFindings}`
  );
}

// ── Main entry point ─────────────────────────────────────────────────────────
/**
 * Exported for unit-testability — pass a PrismaClient to inject a test connection (run against
 * the worker test DB only); without one the CLI entrypoint below bootstraps its own connection
 * from DATABASE_URL.
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

  // The facades only read `app.prisma` / `app.log` (same shim as audit-saldo-chain-integrity.ts).
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const appShim: any = {
    prisma,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    log: { warn: (...a: any[]) => console.warn(...a), info: (...a: any[]) => console.info(...a) },
  };

  try {
    const tenants = args.allTenants
      ? await prisma.tenant.findMany({ select: { id: true } })
      : [{ id: args.tenantId! }];

    let findingCount = 0;
    let highPriorityCount = 0;

    const tenantIds = tenants.map((t) => t.id);
    const employeesScanned = await prisma.employee.count({
      where: { tenantId: { in: tenantIds } },
    });

    // One query for all selected tenants (the scope is the tenant-id filter): only snapshots with a
    // stored carry can ever be a finding, so everything else is never read. Ids only — no name,
    // no employee number (DSGVO).
    const candidateRows = await prisma.saldoSnapshot.findMany({
      where: {
        periodType: "MONTHLY",
        superseded: false,
        carryOver: { not: 0 },
        employee: { tenantId: { in: tenantIds } },
      },
      orderBy: [{ employeeId: "asc" }, { periodStart: "asc" }],
      select: {
        id: true,
        periodStart: true,
        periodEnd: true,
        carryOver: true,
        balanceMinutes: true,
        workedMinutes: true,
        expectedMinutes: true,
        employee: { select: { id: true, tenantId: true } },
      },
    });
    const byEmployee = new Map<
      string,
      { emp: { id: string; tenantId: string }; snapshots: typeof candidateRows }
    >();
    for (const row of candidateRows) {
      const entry = byEmployee.get(row.employee.id);
      if (entry) entry.snapshots.push(row);
      else byEmployee.set(row.employee.id, { emp: row.employee, snapshots: [row] });
    }
    const tzByTenant = new Map<string, string>();

    // Contract rows of every employee with a candidate snapshot, in one read. The contract valid at
    // a month midpoint is then resolved in memory exactly like `getEffectiveSchedule`: the newest
    // row with `validFrom <= date`. (No row at all resolves to a FIXED_SCHEDULE default, which is
    // never track-only, so "no row" is simply "not a finding".)
    const contractRows = await prisma.workSchedule.findMany({
      where: { employeeId: { in: [...byEmployee.keys()] } },
      orderBy: [{ employeeId: "asc" }, { validFrom: "desc" }],
      select: {
        employeeId: true,
        validFrom: true,
        type: true,
        overtimeMode: true,
        monthlyHours: true,
      },
    });
    const contractsByEmployee = new Map<string, typeof contractRows>();
    for (const row of contractRows) {
      const list = contractsByEmployee.get(row.employeeId);
      if (list) list.push(row);
      else contractsByEmployee.set(row.employeeId, [row]);
    }

    // Documented opening balances (Phase 99) of the same employees — a month holding one is not a
    // re-close candidate (WR-02).
    const openingBalanceRows = await prisma.openingBalance.findMany({
      where: { employeeId: { in: [...byEmployee.keys()] }, superseded: false },
      select: { employeeId: true, effectiveFrom: true },
    });
    const openingBalanceMonths = new Map<string, Set<string>>();
    for (const row of openingBalanceRows) {
      const months = openingBalanceMonths.get(row.employeeId) ?? new Set<string>();
      months.add(row.effectiveFrom.toISOString().slice(0, 7));
      openingBalanceMonths.set(row.employeeId, months);
    }

    for (const { emp, snapshots } of byEmployee.values()) {
      if (!tzByTenant.has(emp.tenantId)) {
        tzByTenant.set(emp.tenantId, await getTenantTimezone(prisma, emp.tenantId));
      }
      const tz = tzByTenant.get(emp.tenantId)!;

      const findings: Finding[] = [];
      let lastFindingMidpoint: Date | null = null;

      for (const snap of snapshots) {
        // @db.Date columns: the midpoint is always safely inside the real calendar month, even
        // for a tenant east of UTC where periodStart is the previous UTC date (same derivation
        // as dry-run-433-monthly-hours-soll.ts).
        const periodMidpoint = new Date(
          (snap.periodStart.getTime() + snap.periodEnd.getTime()) / 2,
        );
        const year = periodMidpoint.getUTCFullYear();
        const month = periodMidpoint.getUTCMonth() + 1; // 1-based
        const { start: monthStart, end: monthEnd } = monthRangeUtc(year, month, tz);
        const midMonth = new Date((monthStart.getTime() + monthEnd.getTime()) / 2);

        // Same contract resolution as every close path: the contract valid at the month midpoint.
        const schedule = (contractsByEmployee.get(emp.id) ?? []).find(
          (row) => row.validFrom.getTime() <= midMonth.getTime(),
        );
        if (!schedule || !isTrackOnlySchedule(schedule)) continue;

        const locked = await isSnapshotLocked(prisma, emp.id, emp.tenantId, monthStart, monthEnd);
        const storedMode = String(schedule.overtimeMode ?? "");
        const monthLabel = monthLabelFromPeriodEnd(snap.periodEnd);
        const isOpeningBalance =
          isBridgeSnapshot(snap) || (openingBalanceMonths.get(emp.id)?.has(monthLabel) ?? false);
        findings.push({
          tenantId: emp.tenantId,
          employeeId: emp.id,
          snapshotId: snap.id,
          month: monthLabel,
          storedCarryOver: snap.carryOver,
          balanceMinutes: snap.balanceMinutes,
          locked,
          overtimeMode: storedMode,
          monthlyHours: schedule.monthlyHours == null ? null : Number(schedule.monthlyHours),
          reason: isOpeningBalance
            ? "OPENING_BALANCE"
            : storedMode === "TRACK_ONLY"
              ? "TRACK_ONLY_MODE"
              : "NO_TARGET",
        });
        lastFindingMidpoint = midMonth;
      }

      if (findings.length === 0) continue;
      findingCount += findings.length;
      for (const f of findings) console.info(formatFindingLine(f));

      const confirmed = await getConfirmedCarryOver(prisma, emp.id, emp.tenantId);
      const breakdown = await computeOvertimeBalanceBreakdown(appShim, emp.id);
      const todaySchedule = await getEffectiveSchedule(appShim, emp.id);

      // Any contract starting after the last affected month that is NOT track-only would pick up
      // the stale stored carry as its opening balance.
      const laterRows = (contractsByEmployee.get(emp.id) ?? []).filter(
        (row) => row.validFrom.getTime() > lastFindingMidpoint!.getTime(),
      );
      const laterContractWithTarget = laterRows.some((row) => !isTrackOnlySchedule(row));

      const yearlyNonZeroCarry = await prisma.saldoSnapshot.count({
        where: {
          employeeId: emp.id,
          periodType: "YEARLY",
          superseded: false,
          carryOver: { not: 0 },
        },
      });

      const todayContractAffected = isTrackOnlySchedule(todaySchedule);
      // WR-01: the Ueberstundenausgleich booking gate reads the STORED carry (D-12), so a positive
      // legacy carry stays bookable while the live saldo already shows 0.
      const priorityReasons: PriorityReason[] = [];
      if (laterContractWithTarget) priorityReasons.push("LATER_CONTRACT_WITH_TARGET");
      if (todayContractAffected && confirmed.minutes > 0) {
        priorityReasons.push("BOOKABLE_LEGACY_CARRY");
      }

      const summary: EmployeeSummary = {
        tenantId: emp.tenantId,
        employeeId: emp.id,
        findings: findings.length,
        lastActiveCarryOver: confirmed.minutes,
        liveAfterMinutes: breakdown ? Math.round(breakdown.totalHours * 60) : "exempt",
        todayContractAffected,
        laterContractWithTarget,
        priority: priorityReasons.length > 0 ? "HIGH" : "normal",
        priorityReasons,
        yearlyNonZeroCarry,
        openingBalanceFindings: findings.filter((f) => f.reason === "OPENING_BALANCE").length,
      };
      if (summary.priority === "HIGH") highPriorityCount++;
      console.info(formatEmployeeLine(summary));
    }

    if (findingCount === 0) {
      console.info("No stored carry-over of a track-only month found for the given scope.");
    } else {
      console.info(
        `\nSummary: ${findingCount} finding(s), ${highPriorityCount} HIGH-priority employee(s), ` +
          `${employeesScanned} employee(s) scanned across ${tenants.length} tenant(s). ` +
          `Correction runs only via unlock + re-close of the affected month — this script writes nothing. ` +
          `Never unlock/re-close a reason=OPENING_BALANCE row: it would destroy the opening balance.`,
      );
    }

    return findingCount > 0 ? EXIT_FINDINGS : EXIT_OK;
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

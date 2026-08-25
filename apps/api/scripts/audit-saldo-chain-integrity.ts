/**
 * Phase 98 (AUDIT-CHAIN-01..04) — Saldo-Ketten-Integritätsprüfung.
 *
 * Walks every employee's ACTIVE (superseded=false) MONTHLY SaldoSnapshot chain across all
 * tenants and asserts the chain identity carryOver == carryOverIn + balanceMinutes at every
 * link. Every deviation is classified as a documented injection or an unexplained carry-over
 * jump (see src/utils/saldo-chain-classification.ts).
 *
 * READ-ONLY. ZERO mutations. There is NO --apply flag and none may ever be added:
 * a detector that can also repair will eventually be run in repair mode by accident on
 * payroll data (Phase 98 CONTEXT.md, locked decision).
 *
 * Output contains NO employee names and NO employee numbers — truncated ids only.
 * This DELIBERATELY deviates from audit-workdays-vs-day-hours.ts and
 * audit-workschedule-non-month1.ts, which print names. Do not "fix" it back (DSGVO;
 * this report is expected to be pasted into issue trackers and CI logs).
 *
 * Run:
 *   DATABASE_URL=... pnpm --filter @clokr/api exec tsx scripts/audit-saldo-chain-integrity.ts
 *
 * Exit codes:
 *   0 — chain intact (no unexplained deltas, no duplicate-month links)
 *   1 — DATABASE_URL missing, or a DB connection/query failure
 *   2 — unexplained carry-over delta(s) and/or duplicate-month link(s) found
 */
import { PrismaClient } from "@clokr/db";
import { PrismaPg } from "@prisma/adapter-pg";
import pg from "pg";
import { pathToFileURL } from "node:url";
import {
  walkSaldoChain,
  selectChainViolations,
  selectDuplicateMonthLinks,
  isTrackOnlySchedule,
  monthLabelFromPeriodEnd,
} from "../src/utils/saldo-chain-integrity";
import {
  extractAuditReasons,
  classifyChainLink,
  type ClassificationResult,
} from "../src/utils/saldo-chain-classification";
// Imported for its READ-ONLY schedule resolution only (same precedent as
// set-opening-balance.ts importing updateOvertimeAccount) — the audit calls no write function.
import { getEffectiveSchedule } from "../src/routes/time-entries";

// ── Part A: exported pure helpers (DB-free, unit-testable) ────────────────────

export const EXIT_OK = 0;
export const EXIT_ERROR = 1;
export const EXIT_FINDINGS = 2;

/** Truncated, non-identifying id for output. NEVER print names or employee numbers. */
export function truncId(id: string): string {
  return id.slice(0, 8);
}

/**
 * EXIT_FINDINGS when either count > 0, else EXIT_OK.
 *
 * Duplicate-month links also fail the audit — two active rows for one month make the
 * chain unwalkable, so the audit cannot prove integrity, and silence is the failure mode this
 * script exists to eliminate. Remedy: scripts/cleanup-tz-duplicate-snapshots.ts (dry-run first).
 */
export function exitCodeFor(counts: { unexplained: number; duplicateMonth: number }): number {
  return counts.unexplained > 0 || counts.duplicateMonth > 0 ? EXIT_FINDINGS : EXIT_OK;
}

export type FindingLineInput = {
  classification: "documented" | "unexplained";
  employeeId: string;
  monthLabel: string;
  rowId: string;
  carryOverIn: number;
  balanceMinutes: number;
  expectedCarryOver: number;
  storedCarryOver: number;
  delta: number;
  kind: string;
  workedMinutes: number;
  expectedMinutes: number;
  auditReasonCount: number;
  rule: string;
  matchedReason: string | null;
};

function signed(n: number): string {
  return n >= 0 ? `+${n}` : `${n}`;
}

export function formatFindingLine(f: FindingLineInput): string {
  const tag = f.classification === "unexplained" ? "[UNEXPLAINED]" : "[documented ]";
  const matched = f.matchedReason === null ? "-" : `"${f.matchedReason}"`;
  return (
    `${tag} emp=${truncId(f.employeeId)} month=${f.monthLabel} row=${truncId(f.rowId)} ` +
    `carryIn=${f.carryOverIn} balance=${f.balanceMinutes} expected=${f.expectedCarryOver} ` +
    `stored=${f.storedCarryOver} delta=${signed(f.delta)} kind=${f.kind} ` +
    `worked=${f.workedMinutes} expectedMin=${f.expectedMinutes} auditReasons=${f.auditReasonCount} ` +
    `rule=${f.rule} matched=${matched}`
  );
}

// ── Part B: read-only audit runner (only executed when run as a script) ───────

type Finding = FindingLineInput;

async function run(): Promise<number> {
  if (!process.env.DATABASE_URL) {
    console.error("DATABASE_URL is required");
    return EXIT_ERROR;
  }

  const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL });
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const adapter = new PrismaPg(pool as any);
  const prisma = new PrismaClient({ adapter });
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const appShim: any = {
    prisma,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    log: { warn: (...a: any[]) => console.warn(...a), info: (...a: any[]) => console.info(...a) },
  };

  try {
    const employees = await prisma.employee.findMany({
      select: { id: true, tenantId: true, isTimeTrackingExempt: true },
      orderBy: [{ tenantId: "asc" }, { id: "asc" }],
    });

    let totalLinks = 0;
    let zeroDeltaLinks = 0;
    let documentedCount = 0;
    let unexplainedCount = 0;
    let trackOnlySkipped = 0;
    let duplicateMonthCount = 0;
    let employeesWithoutClosedMonths = 0;
    let employeesChecked = 0;
    const tenantIds = new Set<string>();

    const documentedFindings: Array<{ tenantId: string; finding: Finding }> = [];
    const unexplainedFindings: Array<{ tenantId: string; finding: Finding }> = [];
    const duplicateFindings: Array<{
      tenantId: string;
      employeeId: string;
      monthLabel: string;
      rowIds: string[];
    }> = [];

    for (const emp of employees) {
      tenantIds.add(emp.tenantId);

      const rows = await prisma.saldoSnapshot.findMany({
        where: { employeeId: emp.id, periodType: "MONTHLY", superseded: false },
        orderBy: { periodStart: "asc" },
        select: {
          id: true,
          periodStart: true,
          periodEnd: true,
          workedMinutes: true,
          expectedMinutes: true,
          balanceMinutes: true,
          carryOver: true,
        },
      });

      // No active MONTHLY snapshots is a legitimate, common state (new hires, employees
      // fully inside the still-open month) — MUST be counted separately from "no
      // violations", never conflated with it.
      if (rows.length === 0) {
        employeesWithoutClosedMonths++;
        continue;
      }

      employeesChecked++;
      const links = walkSaldoChain(rows);
      totalLinks += links.length;
      zeroDeltaLinks += links.filter((l) => l.delta === 0).length;

      const dupes = selectDuplicateMonthLinks(links);
      for (const d of dupes) {
        const existing = duplicateFindings.find(
          (x) => x.employeeId === emp.id && x.monthLabel === d.monthLabel,
        );
        if (existing) {
          existing.rowIds.push(d.rowId);
        } else {
          duplicateFindings.push({
            tenantId: emp.tenantId,
            employeeId: emp.id,
            monthLabel: d.monthLabel,
            rowIds: [d.rowId],
          });
        }
      }
      duplicateMonthCount += dupes.length;

      const violations = selectChainViolations(links);
      if (violations.length === 0) continue;

      // Lineage prefetch, ONCE per employee that has violations — superseded rows INCLUDED.
      // SaldoSnapshot has no supersededBy forward pointer, so the currently-active row for a
      // month may be the 3rd or 4th distinct id in that month's history. Classification must
      // search the AuditLog across the FULL lineage of row ids for the month, not just the
      // active row's id — this is what made the 2026-08-17 forensic reconstruction possible
      // at all.
      const lineage = await prisma.saldoSnapshot.findMany({
        where: { employeeId: emp.id, periodType: "MONTHLY" }, // NO superseded filter — deliberate
        select: { id: true, periodEnd: true },
      });
      const lineageByMonth = new Map<string, string[]>();
      for (const r of lineage) {
        const label = monthLabelFromPeriodEnd(r.periodEnd);
        const list = lineageByMonth.get(label) ?? [];
        list.push(r.id);
        lineageByMonth.set(label, list);
      }

      for (const l of violations) {
        // TRACK_ONLY filter FIRST (cheapest correct order — only nonzero-delta links are
        // checked). closeEmployeeMonth() forces carryOver = 0 for MONTHLY_HOURS + TRACK_ONLY,
        // so these links violate the identity by design. getEffectiveSchedule is used rather
        // than a cheaper proxy because false positives are this script's primary failure
        // mode and it is not performance-sensitive.
        const midMonth = new Date((l.periodStart.getTime() + l.periodEnd.getTime()) / 2);
        const schedule = await getEffectiveSchedule(appShim, emp.id, midMonth);
        if (isTrackOnlySchedule(schedule)) {
          trackOnlySkipped++;
          continue;
        }

        const lineageIds = lineageByMonth.get(l.monthLabel) ?? [l.rowId];
        const auditRows = await prisma.auditLog.findMany({
          where: { entity: "SaldoSnapshot", entityId: { in: lineageIds } },
          orderBy: { createdAt: "asc" },
          select: { newValue: true },
        });
        const reasons = extractAuditReasons(auditRows);
        const verdict: ClassificationResult = classifyChainLink(l, reasons);

        const finding: Finding = {
          classification: verdict.classification,
          employeeId: emp.id,
          monthLabel: l.monthLabel,
          rowId: l.rowId,
          carryOverIn: l.carryOverIn,
          balanceMinutes: l.balanceMinutes,
          expectedCarryOver: l.expectedCarryOver,
          storedCarryOver: l.storedCarryOver,
          delta: l.delta,
          kind: l.kind,
          workedMinutes: l.workedMinutes,
          expectedMinutes: l.expectedMinutes,
          auditReasonCount: reasons.length,
          rule: verdict.rule,
          matchedReason: verdict.matchedReason,
        };

        if (verdict.classification === "unexplained") {
          unexplainedCount++;
          unexplainedFindings.push({ tenantId: emp.tenantId, finding });
        } else {
          documentedCount++;
          documentedFindings.push({ tenantId: emp.tenantId, finding });
        }
      }
    }

    // ── Output: findings grouped by tenant then employee ──────────────────────
    // UNEXPLAINED first, documented after, so the important class is never buried.
    const allFindings: Array<{ tenantId: string; finding: Finding }> = [
      ...unexplainedFindings,
      ...documentedFindings,
    ];
    if (allFindings.length === 0) {
      console.log("No chain-integrity findings.");
    } else {
      let currentTenant = "";
      let currentEmployee = "";
      for (const { tenantId, finding } of allFindings) {
        if (tenantId !== currentTenant) {
          // Tenant NAME is deliberately not printed — keeps the report safe to paste anywhere.
          console.log(`\n== Tenant: ${truncId(tenantId)} ==`);
          currentTenant = tenantId;
          currentEmployee = "";
        }
        if (finding.employeeId !== currentEmployee) {
          console.log(`  -- emp=${truncId(finding.employeeId)} --`);
          currentEmployee = finding.employeeId;
        }
        console.log(`     ${formatFindingLine(finding)}`);
      }
    }

    // ── Duplicate-month section, only when findings exist ──────────────────────
    if (duplicateMonthCount > 0) {
      console.log(`\n-- Duplicate-month links (chain unwalkable for that month) --`);
      for (const d of duplicateFindings) {
        console.log(
          `  emp=${truncId(d.employeeId)} month=${d.monthLabel} rows=${d.rowIds.length} ` +
            `rowIds=${d.rowIds.map(truncId).join(",")}`,
        );
      }
      console.log(`  Remediation: scripts/cleanup-tz-duplicate-snapshots.ts (dry-run first).`);
    }

    // ── Summary ──────────────────────────────────────────────────────────────
    console.log(
      `\nSummary: ${totalLinks} active MONTHLY snapshot(s) across ${employeesChecked} employee(s) ` +
        `in ${tenantIds.size} tenant(s) checked.`,
    );
    console.log(`  delta==0 links:                            ${zeroDeltaLinks}`);
    console.log(`  documented deltas:                         ${documentedCount}`);
    console.log(`  UNEXPLAINED deltas:                        ${unexplainedCount}`);
    console.log(`  TRACK_ONLY links skipped:                  ${trackOnlySkipped}`);
    console.log(`  duplicate-month links:                     ${duplicateMonthCount}`);
    console.log(`  employees with no closed months (skipped): ${employeesWithoutClosedMonths}`);

    const exitCode = exitCodeFor({
      unexplained: unexplainedCount,
      duplicateMonth: duplicateMonthCount,
    });
    console.log(`\nExit code: ${exitCode}`);
    return exitCode;
  } catch (err) {
    console.error(err);
    return EXIT_ERROR;
  } finally {
    await prisma.$disconnect();
    await pool.end();
  }
}

// Run-guard: only bootstrap the DB + execute when invoked as a script, so importing
// the module for unit tests is side-effect-free (no connection, no process.exit).
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  void run().then((code) => {
    process.exitCode = code;
  });
}

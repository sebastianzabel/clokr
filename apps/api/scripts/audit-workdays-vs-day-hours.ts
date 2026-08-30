/**
 * Phase 61 (v1.6.5) — audit: list every WorkSchedule row whose `workDays`
 * disagrees with the set of weekday indices where the corresponding
 * `{day}Hours` value is > 0.
 *
 * Background: an employee's 2026-05-27 incident traced to WorkSchedule rows
 * stored with `workDays=[1,2,3,4,5]` even though `mondayHours=0`. Phase 61's
 * `normalizeWorkDays()` (apps/api/src/utils/calculate-work-days.ts) prevents
 * new rows from diverging, but legacy rows are preserved per CLAUDE.md
 * Revisionssicherheit — they MUST NOT be auto-migrated or deleted.
 *
 * Read-only. ZERO mutations. Exit 0 even if divergent rows are found.
 *
 * Run:
 *   DATABASE_URL=... pnpm --filter @clokr/api exec tsx scripts/audit-workdays-vs-day-hours.ts
 *
 * Exit codes:
 *   0 — script ran (whether or not it found divergent rows)
 *   1 — DATABASE_URL missing or DB connection failed
 */
import { PrismaClient } from "@clokr/db";
import { PrismaPg } from "@prisma/adapter-pg";
import pg from "pg";
import { pathToFileURL } from "node:url";

// ── Part A: exported pure helpers (DB-free, unit-testable) ────────────────────

export type ScheduleRow = {
  schedule_id: string;
  employee_id: string;
  employee_first_name: string;
  employee_last_name: string;
  employee_number: string;
  tenant_id: string;
  tenant_name: string;
  type: string;
  valid_from: Date;
  work_days: number[];
  monday_hours: string;
  tuesday_hours: string;
  wednesday_hours: string;
  thursday_hours: string;
  friday_hours: string;
  saturday_hours: string;
  sunday_hours: string;
};

/** Weekday index (0=Sun..6=Sat) paired with the ScheduleRow key and short label for each column. */
const DAY_COLUMNS: Array<{ index: number; hourKey: keyof ScheduleRow; label: string }> = [
  { index: 0, hourKey: "sunday_hours", label: "sun" },
  { index: 1, hourKey: "monday_hours", label: "mon" },
  { index: 2, hourKey: "tuesday_hours", label: "tue" },
  { index: 3, hourKey: "wednesday_hours", label: "wed" },
  { index: 4, hourKey: "thursday_hours", label: "thu" },
  { index: 5, hourKey: "friday_hours", label: "fri" },
  { index: 6, hourKey: "saturday_hours", label: "sat" },
];

function hourValueOf(row: ScheduleRow, dayIndex: number): string {
  return row[DAY_COLUMNS[dayIndex].hourKey] as string;
}

/** Sorted weekday indices (0=Sun..6=Sat) whose {day}Hours value is > 0. */
export function deriveWorkDaysFromDayHours(row: ScheduleRow): number[] {
  return DAY_COLUMNS.filter((c) => Number(row[c.hourKey]) > 0)
    .map((c) => c.index)
    .sort((a, b) => a - b);
}

export type Classification = {
  divergent: boolean;
  expected: boolean;
  derived: number[];
  offending: string[];
};

/**
 * Classify one WorkSchedule row. `divergent` uses the original Phase 61 rule verbatim: a row
 * with all-zero day-hours (`derived` empty) is never flagged, regardless of `work_days` — this
 * is the D-07 asymmetry. `expected` is Phase 95b's new information: a divergent SHIFT_BASED row
 * is an expected finding (Phase 107), not a bug.
 */
export function classifyScheduleRow(row: ScheduleRow): Classification {
  const derived = deriveWorkDaysFromDayHours(row);
  const stored = (row.work_days ?? []).slice().sort((a, b) => a - b);

  const sameLength = stored.length === derived.length;
  const sameContents = sameLength && stored.every((v, i) => v === derived[i]);

  // Divergence rule (unchanged from Phase 61):
  //   - If derived is empty (all per-day-hours = 0, e.g. MONTHLY_HOURS), do NOT flag — there's
  //     nothing to derive from. The schema default and tenant fallback both apply legitimately
  //     in that case (D-07 asymmetry).
  //   - Otherwise flag whenever stored != derived.
  const divergent = derived.length > 0 && !sameContents;

  const offending: string[] = [];
  if (divergent) {
    const storedSet = new Set(stored);
    const derivedSet = new Set(derived);
    for (const d of storedSet) {
      if (!derivedSet.has(d)) {
        offending.push(`workDays-has-${d}-but-${DAY_COLUMNS[d].label}Hours=${hourValueOf(row, d)}`);
      }
    }
    for (const d of derivedSet) {
      if (!storedSet.has(d)) {
        offending.push(
          `workDays-missing-${d}-but-${DAY_COLUMNS[d].label}Hours=${hourValueOf(row, d)}`,
        );
      }
    }
  }

  return {
    divergent,
    expected: divergent && row.type === "SHIFT_BASED",
    derived,
    offending,
  };
}

// ── Part B: read-only audit runner (only executed when run as a script) ───────

async function run(): Promise<number> {
  if (!process.env.DATABASE_URL) {
    console.error("DATABASE_URL is required");
    return 1;
  }

  const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL });
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const adapter = new PrismaPg(pool as any);
  const prisma = new PrismaClient({ adapter });

  try {
    // Pull every WorkSchedule row with its per-day-hours and join Employee + Tenant for
    // context. Comparison of `workDays` against the derived set is done in JS (array-equality
    // predicate in SQL is awkward across PG versions).
    const rows = await prisma.$queryRaw<ScheduleRow[]>`
      SELECT
        ws.id              AS schedule_id,
        ws."employeeId"    AS employee_id,
        e."firstName"      AS employee_first_name,
        e."lastName"       AS employee_last_name,
        e."employeeNumber" AS employee_number,
        e."tenantId"       AS tenant_id,
        t.name             AS tenant_name,
        ws.type            AS type,
        ws."validFrom"     AS valid_from,
        ws."workDays"      AS work_days,
        ws."mondayHours"    AS monday_hours,
        ws."tuesdayHours"   AS tuesday_hours,
        ws."wednesdayHours" AS wednesday_hours,
        ws."thursdayHours"  AS thursday_hours,
        ws."fridayHours"    AS friday_hours,
        ws."saturdayHours"  AS saturday_hours,
        ws."sundayHours"    AS sunday_hours
      FROM "WorkSchedule" ws
      JOIN "Employee" e ON e.id = ws."employeeId"
      JOIN "Tenant"   t ON t.id = e."tenantId"
      ORDER BY t.name ASC, e."lastName" ASC, ws."validFrom" ASC;
    `;

    const divergent = rows
      .map((r) => ({ ...r, ...classifyScheduleRow(r) }))
      .filter((r) => r.divergent);

    if (divergent.length === 0) {
      console.log("No WorkSchedule rows with workDays diverging from per-day-hours.");
      return 0;
    }

    console.log(`Found ${divergent.length} divergent WorkSchedule row(s):\n`);

    let currentTenant = "";
    for (const r of divergent) {
      if (r.tenant_id !== currentTenant) {
        console.log(`\n== Tenant: ${r.tenant_name} (${r.tenant_id}) ==`);
        currentTenant = r.tenant_id;
      }

      console.log(
        `  [${r.type.padEnd(15)}] ${r.employee_number.padEnd(12)} ` +
          `${r.employee_first_name} ${r.employee_last_name} ` +
          `— scheduleId=${r.schedule_id} ` +
          `stored=[${(r.work_days ?? []).join(",")}] derived=[${r.derived.join(",")}] ` +
          `validFrom=${r.valid_from.toISOString()} ` +
          `(${r.offending.join(", ")})`,
      );
    }
    console.log(
      `\nReview manually via /admin/employees/{id}. Phase 61 prevents new ` +
        `divergent rows but does NOT auto-migrate (Revisionssicherheit).`,
    );
    return 0;
  } catch (err) {
    console.error(err);
    return 1;
  } finally {
    await prisma.$disconnect();
    await pool.end();
  }
}

// Run-guard: only bootstrap the DB + execute when invoked as a script, so importing the
// module for unit tests is side-effect-free (no connection, no process.exit).
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  void run().then((code) => {
    process.exitCode = code;
  });
}

/**
 * Phase 76.41 (v1.8.22) — Break-Konsistenz-Audit (SALDO-12 / D-04).
 *
 * Lists every non-soft-deleted `TimeEntry` whose stored integer `breakMinutes`
 * diverges from the rounded sum of its `Break` rows
 * (`Math.round(Σ (endTime − startTime) / 60000)`), grouped by tenant then employee.
 *
 * The divergence reference replicates the write path EXACTLY — see
 * `calcBreakMinutes` (apps/api/src/routes/time-entries.ts:84) + the
 * `Math.round(calcBreakMinutes(allBreaks))` at :829 (D-03). A consistent row
 * (Neele reference 5.25h == 5.25h) is therefore never flagged.
 *
 * Legacy integer-only entries (`breakMinutes > 0` with ZERO `Break` rows) are the
 * intentional legacy model (CLAUDE.md "legacy: breakMinutes integer"). They are
 * reported in a SEPARATE informational bucket, NOT as a hard divergence (D-04), so
 * operators can distinguish real data corruption from the legacy model. A fully
 * consistent zero row (`breakMinutes == 0`, no `Break` rows) is never flagged.
 *
 * Read-only. ZERO mutations. No write flag exists. Corrections are handled manually via
 * the admin UI, consistent with Revisionssicherheit (legacy rows are never auto-migrated).
 *
 * Run:
 *   DATABASE_URL=... pnpm --filter @clokr/api exec tsx scripts/audit-break-consistency.ts
 *
 * Exit codes:
 *   0 — script ran (whether or not it found divergences — this is an ops report, not a CI gate, D-02)
 *   1 — DATABASE_URL missing or DB connection failed
 */
import { PrismaClient } from "@clokr/db";
import { PrismaPg } from "@prisma/adapter-pg";
import pg from "pg";
import { pathToFileURL } from "node:url";

// ── Part A: exported pure helpers (DB-free, unit-testable) ────────────────────

type BreakRow = { startTime: Date; endTime: Date };

/**
 * Rounded sum of Break-row minutes — replicates the write path EXACTLY:
 * `Math.round(calcBreakMinutes(...))` from time-entries.ts:84 + :829 (D-03).
 */
export function computeBreakRowMinutes(breakRows: BreakRow[]): number {
  return Math.round(
    breakRows.reduce((sum, b) => sum + (b.endTime.getTime() - b.startTime.getTime()) / 60000, 0),
  );
}

/**
 * A row is a HARD divergence only when it has ≥1 Break row and the stored
 * breakMinutes differs from the rounded Break-row sum. The legacy case
 * (zero Break rows) is NEVER a hard divergence (D-04).
 */
export function isBreakDivergent(storedBreakMinutes: number, breakRows: BreakRow[]): boolean {
  return breakRows.length > 0 && storedBreakMinutes !== computeBreakRowMinutes(breakRows);
}

/**
 * Classify a TimeEntry's break data:
 *   "legacy"     — breakMinutes > 0 with zero Break rows (intentional legacy model, D-04).
 *   "divergent"  — ≥1 Break row and stored != rounded sum (real corruption to review).
 *   "consistent" — everything else (incl. breakMinutes == 0 with no Break rows).
 */
export function classifyBreakRow(
  storedBreakMinutes: number,
  breakRows: BreakRow[],
): "consistent" | "divergent" | "legacy" {
  if (breakRows.length === 0) {
    return storedBreakMinutes > 0 ? "legacy" : "consistent";
  }
  return isBreakDivergent(storedBreakMinutes, breakRows) ? "divergent" : "consistent";
}

// ── Part B: read-only audit runner (only executed when run as a script) ───────

async function run(): Promise<void> {
  if (!process.env.DATABASE_URL) {
    console.error("DATABASE_URL is required");
    process.exit(1);
  }

  const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL });
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const adapter = new PrismaPg(pool as any);
  const prisma = new PrismaClient({ adapter });

  async function main() {
    // (a) All non-soft-deleted TimeEntry rows with employee + tenant context (D-05).
    //     Ordered tenant → employee → date for grouped console output (D-06).
    const entries = await prisma.$queryRaw<
      Array<{
        time_entry_id: string;
        entry_date: Date;
        break_minutes: number;
        is_locked: boolean;
        employee_id: string;
        employee_first_name: string;
        employee_last_name: string;
        employee_number: string;
        tenant_id: string;
        tenant_name: string;
      }>
    >`
      SELECT
        te.id              AS time_entry_id,
        te."date"          AS entry_date,
        te."breakMinutes"  AS break_minutes,
        te."isLocked"      AS is_locked,
        e.id               AS employee_id,
        e."firstName"      AS employee_first_name,
        e."lastName"       AS employee_last_name,
        e."employeeNumber" AS employee_number,
        e."tenantId"       AS tenant_id,
        t.name             AS tenant_name
      FROM "TimeEntry" te
      JOIN "Employee" e ON e.id = te."employeeId"
      JOIN "Tenant"   t ON t.id = e."tenantId"
      WHERE te."deletedAt" IS NULL
      ORDER BY t.name ASC, e."lastName" ASC, te."date" ASC;
    `;

    // (b) All Break rows for those entries, grouped by timeEntryId in JS
    //     (mirrors the pattern script's "predicate in JS" convention).
    const entryIds = entries.map((e) => e.time_entry_id);
    const breakRows =
      entryIds.length === 0
        ? []
        : await prisma.$queryRaw<
            Array<{ time_entry_id: string; start_time: Date; end_time: Date }>
          >`
            SELECT
              "timeEntryId" AS time_entry_id,
              "startTime"   AS start_time,
              "endTime"     AS end_time
            FROM "Break"
            WHERE "timeEntryId" = ANY(${entryIds});
          `;

    const breaksByEntry = new Map<string, BreakRow[]>();
    for (const b of breakRows) {
      const list = breaksByEntry.get(b.time_entry_id) ?? [];
      list.push({ startTime: b.start_time, endTime: b.end_time });
      breaksByEntry.set(b.time_entry_id, list);
    }

    type Row = (typeof entries)[number] & {
      rows: BreakRow[];
      computed: number;
    };
    const divergent: Row[] = [];
    const legacy: Row[] = [];

    for (const e of entries) {
      const rows = breaksByEntry.get(e.time_entry_id) ?? [];
      const category = classifyBreakRow(e.break_minutes, rows);
      const enriched: Row = { ...e, rows, computed: computeBreakRowMinutes(rows) };
      if (category === "divergent") divergent.push(enriched);
      else if (category === "legacy") legacy.push(enriched);
    }

    // ── Output: true divergences grouped by tenant → employee (D-06) ──────────
    if (divergent.length === 0) {
      console.log("Keine Break-Konsistenz-Abweichungen gefunden.");
    } else {
      console.log(`Gefundene Break-Konsistenz-Abweichungen: ${divergent.length}\n`);
      let currentTenant = "";
      let currentEmployee = "";
      for (const r of divergent) {
        if (r.tenant_id !== currentTenant) {
          console.log(`\n== Tenant: ${r.tenant_name} (${r.tenant_id}) ==`);
          currentTenant = r.tenant_id;
          currentEmployee = "";
        }
        if (r.employee_id !== currentEmployee) {
          console.log(
            `  -- ${r.employee_number} ${r.employee_first_name} ${r.employee_last_name} --`,
          );
          currentEmployee = r.employee_id;
        }
        const diff = r.break_minutes - r.computed;
        console.log(
          `     date=${r.entry_date.toISOString().slice(0, 10)} ` +
            `timeEntryId=${r.time_entry_id} ` +
            `stored=${r.break_minutes} sumOfBreakRows=${r.computed} diff=${diff} ` +
            `breakRowCount=${r.rows.length} isLocked=${r.is_locked}`,
        );
      }
    }

    // ── Legacy integer-only bucket (informational, NOT a divergence, D-04) ────
    if (legacy.length > 0) {
      console.log(
        `\n-- Legacy integer-only breaks (breakMinutes>0, keine Break-Rows) — informativ, KEINE Divergenz --`,
      );
      let currentTenant = "";
      for (const r of legacy) {
        if (r.tenant_id !== currentTenant) {
          console.log(`\n== Tenant: ${r.tenant_name} (${r.tenant_id}) ==`);
          currentTenant = r.tenant_id;
        }
        console.log(
          `     date=${r.entry_date.toISOString().slice(0, 10)} ` +
            `timeEntryId=${r.time_entry_id} ` +
            `${r.employee_number} ${r.employee_first_name} ${r.employee_last_name} ` +
            `stored=${r.break_minutes} breakRowCount=0 isLocked=${r.is_locked}`,
        );
      }
    }

    // ── Summary (D-07) ────────────────────────────────────────────────────────
    console.log(
      `\nZusammenfassung: ${entries.length} TimeEntries geprüft, ` +
        `${divergent.length} echte Divergenz(en), ` +
        `${legacy.length} Legacy-Integer-Zeile(n).`,
    );
    console.log(
      `Review manuell via Admin-UI. Korrekturen NUR manuell (Revisionssicherheit — keine Auto-Migration).`,
    );
  }

  await main()
    .catch((err) => {
      console.error(err);
      process.exit(1);
    })
    .finally(async () => {
      await prisma.$disconnect();
      await pool.end();
    });
}

// Run-guard: only bootstrap the DB + execute when invoked as a script, so importing
// the module for unit tests is side-effect-free (no connection, no process.exit).
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  void run();
}

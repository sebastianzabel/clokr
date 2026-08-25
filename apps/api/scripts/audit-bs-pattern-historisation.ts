/**
 * Phase 103 Plan 02 (Wave-0 fact-finding) — read-only audit of
 * EmployeeVocationalSchoolPattern historisation anomalies.
 *
 * 103-BEFUND.md "Zweiter Befund" documents two rows for one employee sharing
 * validFrom=2026-05-01, both validUntil=NULL — the historisation never closes a
 * superseded pattern, so which row "wins" a `findFirst({ orderBy: { validFrom: "desc" } })`
 * tie is undefined. 103-RESEARCH.md § "Pattern Historisation — Options" could not determine
 * the LIVE isActive cardinality of those rows without querying a database, which this
 * script does. See 103-HISTORISATION-DIAGNOSTIC.md for the findings and the owner's choice
 * of remediation option (A / B / C).
 *
 * Four independent flags, computed per employee across ALL of that employee's
 * EmployeeVocationalSchoolPattern rows:
 *   MULTI_ACTIVE      — more than one row is isActive:true right now. If this fires,
 *                        runOrPreview()'s findMany-over-all-active-patterns
 *                        (vocational-school-generator.ts) additively double-applies both
 *                        patterns' claimed days — a currently-LIVE bug, not just an
 *                        audit-quality gap.
 *   UNCLOSED_HISTORY   — a superseded row (isActive:false) with validUntil still NULL.
 *                        Audit-quality only: a reader of the raw table cannot tell when the
 *                        pattern stopped being in effect.
 *   TIED_VALIDFROM     — two or more rows (any isActive) share one validFrom date. Feeds the
 *                        nondeterministic-winner risk in every
 *                        findFirst({ orderBy: { validFrom: "desc" } }) resolution
 *                        (vocational-school-saldo.ts, vocational-school-pattern.ts).
 *   OVERLAPPING_CLAIM  — two isActive:true rows whose validity ranges overlap AND whose
 *                        claimed calendar days overlap (daysOfWeek intersection, or a
 *                        daysOfWeek pattern's weekday landing inside the other's
 *                        blockWeeks/blockYear ISO weeks, or two blockWeeks patterns sharing
 *                        a block week). Mirrors the actual day-matching logic in
 *                        runOrPreview() (vocational-school-generator.ts:309-347), not just a
 *                        raw-row heuristic — see blockWeekDates() below.
 *
 * Read-only. ZERO mutations. No write-enabling command-line flag exists, and none should
 * ever be added — this script is diagnostic input to a decision the owner makes by hand
 * (103-02-PLAN.md Task 3), not a repair tool. This file's own invariant: a grep for
 * `\.(create|update|delete|updateMany|deleteMany|upsert)\(|\$executeRaw` in this file must
 * return nothing.
 *
 * NO PII: the Prisma select lists only structural fields (id, employeeId, validFrom,
 * validUntil, isActive, createdAt, daysOfWeek, blockWeeks, blockYear) — never anything from
 * the Employee model's identity fields. Employees are printed as the first 8 characters of
 * their UUID (truncId), matching audit-saldo-chain-integrity.ts's convention.
 *
 * Run:
 *   DATABASE_URL=... pnpm --filter @clokr/api exec tsx scripts/audit-bs-pattern-historisation.ts
 *
 * Exit codes:
 *   0 — script ran (whether or not anomalies were found — this is a diagnostic report, not
 *       a CI gate; a routine pre-deploy run must never fail just because rows exist)
 *   1 — DATABASE_URL missing or DB connection failed
 */
import { PrismaClient } from "@clokr/db";
import { PrismaPg } from "@prisma/adapter-pg";
import pg from "pg";
import { pathToFileURL } from "node:url";

// ── Part A: exported pure helpers (DB-free, unit-testable) ────────────────────

export const EXIT_OK = 0;
export const EXIT_ERROR = 1;

/** Truncated, non-identifying id for output. NEVER print names or an employee number. */
export function truncId(id: string): string {
  return id.slice(0, 8);
}

export type PatternRow = {
  id: string;
  validFrom: Date;
  validUntil: Date | null;
  isActive: boolean;
  createdAt: Date;
  daysOfWeek: number[];
  blockWeeks: number[];
  blockYear: number | null;
};

export type ClassifyResult = { flags: string[] };

// JS max representable Date — stands in for "open-ended, forever" when validUntil is null.
const MAX_DATE = new Date(8_640_000_000_000_000);

function effectiveUntil(validUntil: Date | null): Date {
  return validUntil ?? MAX_DATE;
}

/** True when two [validFrom, validUntil] ranges (validUntil=null = open-ended) overlap. */
function rangesOverlap(a: PatternRow, b: PatternRow): boolean {
  return (
    a.validFrom.getTime() <= effectiveUntil(b.validUntil).getTime() &&
    b.validFrom.getTime() <= effectiveUntil(a.validUntil).getTime()
  );
}

function weekdaySetsIntersect(a: number[], b: number[]): boolean {
  const setB = new Set(b);
  return a.some((d) => setB.has(d));
}

/**
 * Map JS-native getUTCDay (0=Sun..6=Sat) onto the schema's Mo-based convention (0=Mo..6=So).
 * Deliberately duplicated (not imported) from vocational-school-generator.ts's
 * dowMondayBased() — that module carries Fastify-app-shaped dependencies and is not
 * script-safe to import; this predicate is 3 lines and cheap to keep in lockstep by hand.
 */
function dowMondayBased(d: Date): number {
  const native = d.getUTCDay();
  return native === 0 ? 6 : native - 1;
}

/**
 * The Monday of a given ISO week/year, at UTC midnight. Inverse of the generator's
 * isoWeekOf(); mirrors vocational-school-generator.ts:113-121's algorithm.
 */
function isoWeekMonday(isoYear: number, isoWeek: number): Date {
  const jan4 = new Date(Date.UTC(isoYear, 0, 4));
  const jan4Dow = jan4.getUTCDay() || 7; // Mon=1..Sun=7
  const week1Monday = new Date(jan4);
  week1Monday.setUTCDate(jan4.getUTCDate() - (jan4Dow - 1));
  const target = new Date(week1Monday);
  target.setUTCDate(week1Monday.getUTCDate() + (isoWeek - 1) * 7);
  return target;
}

/**
 * Concrete Mon-Fr calendar dates a blockWeeks pattern claims. Block weeks are ALWAYS Mo-Fr
 * per vocational-school-generator.ts:337-346 (BBiG §15 Abs.1 Nr.3 — Blockunterricht is a
 * 5-day school week; explicit Saturday models are out of scope for this schema).
 */
function blockWeekDates(blockYear: number, blockWeeks: number[]): Date[] {
  const dates: Date[] = [];
  for (const week of blockWeeks) {
    const monday = isoWeekMonday(blockYear, week);
    for (let i = 0; i < 5; i++) {
      dates.push(new Date(monday.getTime() + i * 86_400_000));
    }
  }
  return dates;
}

function withinValidity(date: Date, row: PatternRow): boolean {
  return (
    date.getTime() >= row.validFrom.getTime() &&
    date.getTime() <= effectiveUntil(row.validUntil).getTime()
  );
}

/**
 * True when two isActive:true rows structurally claim at least one common calendar day —
 * mirrors runOrPreview()'s per-date "intended" decision
 * (vocational-school-generator.ts:330-347), not just a raw-field heuristic. Weekday-vs-weekday,
 * weekday-vs-blockWeeks (both directions), and blockWeeks-vs-blockWeeks are all checked.
 */
function claimsOverlap(a: PatternRow, b: PatternRow): boolean {
  if (!rangesOverlap(a, b)) return false;

  const aWeekday = a.daysOfWeek.length > 0;
  const bWeekday = b.daysOfWeek.length > 0;
  const aBlock = a.blockWeeks.length > 0 && a.blockYear !== null;
  const bBlock = b.blockWeeks.length > 0 && b.blockYear !== null;

  if (aWeekday && bWeekday && weekdaySetsIntersect(a.daysOfWeek, b.daysOfWeek)) {
    return true;
  }

  if (aWeekday && bBlock) {
    for (const d of blockWeekDates(b.blockYear as number, b.blockWeeks)) {
      if (
        a.daysOfWeek.includes(dowMondayBased(d)) &&
        withinValidity(d, a) &&
        withinValidity(d, b)
      ) {
        return true;
      }
    }
  }
  if (bWeekday && aBlock) {
    for (const d of blockWeekDates(a.blockYear as number, a.blockWeeks)) {
      if (
        b.daysOfWeek.includes(dowMondayBased(d)) &&
        withinValidity(d, a) &&
        withinValidity(d, b)
      ) {
        return true;
      }
    }
  }
  if (aBlock && bBlock && a.blockYear === b.blockYear) {
    const bWeeks = new Set(b.blockWeeks);
    if (a.blockWeeks.some((w) => bWeeks.has(w))) return true;
  }

  return false;
}

/**
 * Classify one employee's full set of EmployeeVocationalSchoolPattern rows. Pure, DB-free —
 * see the four flag definitions in the file header. Flag order is fixed (MULTI_ACTIVE,
 * UNCLOSED_HISTORY, TIED_VALIDFROM, OVERLAPPING_CLAIM) for stable, testable output.
 */
export function classifyPatternRows(rows: PatternRow[]): ClassifyResult {
  const flags: string[] = [];

  const activeRows = rows.filter((r) => r.isActive);
  if (activeRows.length > 1) flags.push("MULTI_ACTIVE");

  if (rows.some((r) => !r.isActive && r.validUntil === null)) flags.push("UNCLOSED_HISTORY");

  const seenValidFrom = new Set<number>();
  let tied = false;
  for (const r of rows) {
    const t = r.validFrom.getTime();
    if (seenValidFrom.has(t)) {
      tied = true;
      break;
    }
    seenValidFrom.add(t);
  }
  if (tied) flags.push("TIED_VALIDFROM");

  let overlapping = false;
  for (let i = 0; i < activeRows.length && !overlapping; i++) {
    for (let j = i + 1; j < activeRows.length; j++) {
      if (claimsOverlap(activeRows[i], activeRows[j])) {
        overlapping = true;
        break;
      }
    }
  }
  if (overlapping) flags.push("OVERLAPPING_CLAIM");

  return { flags };
}

function fmtDate(d: Date | null): string {
  return d ? d.toISOString().slice(0, 10) : "-";
}

/** One printable line per pattern row, used by the Part B runner's flagged-employee block. */
function formatPatternRow(row: PatternRow): string {
  return (
    `    row id=${truncId(row.id)} validFrom=${fmtDate(row.validFrom)} ` +
    `validUntil=${fmtDate(row.validUntil)} isActive=${row.isActive} ` +
    `createdAt=${row.createdAt.toISOString()} daysOfWeek=[${row.daysOfWeek.join(",")}] ` +
    `blockWeeks=[${row.blockWeeks.join(",")}] blockYear=${row.blockYear ?? "-"}`
  );
}

// ── Part B: read-only audit runner (only executed when run as a script) ───────

async function run(): Promise<number> {
  if (!process.env.DATABASE_URL) {
    console.error("DATABASE_URL is required");
    return EXIT_ERROR;
  }

  const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL });
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const adapter = new PrismaPg(pool as any);
  const prisma = new PrismaClient({ adapter });

  try {
    const rows = await prisma.employeeVocationalSchoolPattern.findMany({
      select: {
        id: true,
        employeeId: true,
        validFrom: true,
        validUntil: true,
        isActive: true,
        createdAt: true,
        daysOfWeek: true,
        blockWeeks: true,
        blockYear: true,
      },
      orderBy: [{ employeeId: "asc" }, { createdAt: "asc" }],
    });

    const byEmployee = new Map<string, PatternRow[]>();
    for (const r of rows) {
      const list = byEmployee.get(r.employeeId) ?? [];
      list.push(r);
      byEmployee.set(r.employeeId, list);
    }

    const flagCounts: Record<string, number> = {
      MULTI_ACTIVE: 0,
      UNCLOSED_HISTORY: 0,
      TIED_VALIDFROM: 0,
      OVERLAPPING_CLAIM: 0,
    };
    let flaggedEmployees = 0;

    if (byEmployee.size === 0) {
      console.log("No EmployeeVocationalSchoolPattern rows found.");
    }

    for (const [employeeId, empRows] of byEmployee) {
      const { flags } = classifyPatternRows(empRows);
      if (flags.length === 0) continue;
      flaggedEmployees++;
      for (const f of flags) flagCounts[f]++;
      console.log(`\n[${flags.join(",")}] emp=${truncId(employeeId)}`);
      for (const row of empRows) {
        console.log(formatPatternRow(row));
      }
    }

    if (flaggedEmployees === 0 && byEmployee.size > 0) {
      console.log(
        "\nNo historisation anomalies found — every employee's pattern history is clean.",
      );
    }

    console.log(
      `\nSummary: ${byEmployee.size} employee(s) with EmployeeVocationalSchoolPattern rows checked.`,
    );
    console.log(`  MULTI_ACTIVE:      ${flagCounts.MULTI_ACTIVE}`);
    console.log(`  UNCLOSED_HISTORY:  ${flagCounts.UNCLOSED_HISTORY}`);
    console.log(`  TIED_VALIDFROM:    ${flagCounts.TIED_VALIDFROM}`);
    console.log(`  OVERLAPPING_CLAIM: ${flagCounts.OVERLAPPING_CLAIM}`);
    console.log(`  Employees flagged: ${flaggedEmployees}`);

    return EXIT_OK;
  } catch (err) {
    console.error(err);
    return EXIT_ERROR;
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

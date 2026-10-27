/**
 * Invariants decided on the database alone (Issue #715). Every statement is a SELECT; the connection
 * the checker hands in cannot write. Findings carry ids and calendar dates only (DSGVO).
 */
import type { CheckContext, Finding, Invariant, InvariantResult, Queryable } from "./types";

async function count(db: Queryable, sql: string, params: unknown[] = []): Promise<number> {
  const { rows } = await db.query<{ n: string | number }>(sql, params);
  return Number(rows[0]?.n ?? 0);
}

// ── 1. no overlapping entries ─────────────────────────────────────────────────

export const noOverlap: Invariant = {
  id: "entries.no-overlap",
  title: "No two closed entries of one person overlap",
  async run(ctx) {
    const { rows } = await ctx.db.query<{ a: string; b: string; tenant: string }>(
      `SELECT a."id" AS a, b."id" AS b, e."tenantId" AS tenant
         FROM "TimeEntry" a
         JOIN "TimeEntry" b ON b."employeeId" = a."employeeId" AND a."id" < b."id"
         JOIN "Employee" e ON e."id" = a."employeeId"
        WHERE a."deletedAt" IS NULL AND b."deletedAt" IS NULL
          AND a."endTime" IS NOT NULL AND b."endTime" IS NOT NULL
          AND a."date" >= $1::date AND b."date" >= $1::date
          AND a."startTime" < b."endTime" AND b."startTime" < a."endTime"`,
      [windowStart(ctx)],
    );
    const examined = await count(
      ctx.db,
      `SELECT count(*) AS n FROM "TimeEntry" WHERE "deletedAt" IS NULL AND "endTime" IS NOT NULL AND "date" >= $1::date`,
      [windowStart(ctx)],
    );
    return result(
      noOverlap,
      examined,
      rows.map((r) => ({
        key: `overlap:${r.a}:${r.b}`,
        group: "overlap",
        message: `Entries ${r.a} and ${r.b} of one person overlap (tenant ${r.tenant}).`,
      })),
    );
  },
};

// ── 2. at most one open entry per person and day ──────────────────────────────

export const singleOpenPerDay: Invariant = {
  id: "entries.single-open-per-day",
  title: "At most one open entry per person and day",
  async run(ctx) {
    const { rows } = await ctx.db.query<{ employee: string; day: string; n: string }>(
      `SELECT "employeeId" AS employee, to_char("date", 'YYYY-MM-DD') AS day, count(*) AS n
         FROM "TimeEntry"
        WHERE "deletedAt" IS NULL AND "endTime" IS NULL
        GROUP BY "employeeId", "date" HAVING count(*) > 1`,
    );
    const examined = await count(
      ctx.db,
      `SELECT count(*) AS n FROM "TimeEntry" WHERE "deletedAt" IS NULL`,
    );
    return result(
      singleOpenPerDay,
      examined,
      rows.map((r) => ({
        key: `multi-open:${r.employee}:${r.day}`,
        group: "multi-open",
        message: `Employee ${r.employee} has ${r.n} open entries on ${r.day}.`,
      })),
    );
  },
};

// ── 3. closed months stay unchanged ───────────────────────────────────────────

const ENTRY_CHECKSUMS = `
  SELECT e."tenantId" AS tenant, t."employeeId" AS employee, to_char(t."date", 'YYYY-MM') AS month,
         md5(string_agg(t."id" || '|' || t."startTime"::text || '|' || coalesce(t."endTime"::text, '')
                        || '|' || t."breakMinutes" || '|' || t."type"::text || '|'
                        || coalesce(t."deletedAt"::text, ''), ',' ORDER BY t."id")) AS hash
    FROM "TimeEntry" t JOIN "Employee" e ON e."id" = t."employeeId"
   WHERE t."isLocked"
   GROUP BY e."tenantId", t."employeeId", to_char(t."date", 'YYYY-MM')`;

const SNAPSHOT_CHECKSUMS = `
  SELECT e."tenantId" AS tenant, s."employeeId" AS employee, to_char(s."periodStart", 'YYYY-MM') AS month,
         md5(string_agg(s."id" || '|' || s."workedMinutes" || '|' || s."expectedMinutes" || '|'
                        || s."balanceMinutes" || '|' || s."carryOver" || '|' || s."superseded"::text,
                        ',' ORDER BY s."id")) AS hash
    FROM "SaldoSnapshot" s JOIN "Employee" e ON e."id" = s."employeeId"
   WHERE s."periodType" = 'MONTHLY'
   GROUP BY e."tenantId", s."employeeId", to_char(s."periodStart", 'YYYY-MM')`;

interface ChecksumRow {
  tenant: string;
  employee: string;
  month: string;
  hash: string;
}

export function compareChecksums(
  kind: "entries" | "snapshots",
  previous: Record<string, string>,
  current: Record<string, string>,
): Finding[] {
  const findings: Finding[] = [];
  for (const [key, hash] of Object.entries(previous)) {
    const now = current[key];
    if (now === undefined) {
      findings.push({
        invariant: "months.closed-unchanged",
        key: `closed-gone:${kind}:${key}`,
        group: `closed-gone:${kind}`,
        message: `A closed month's ${kind} (${key}) existed at the last check and is gone.`,
      });
    } else if (now !== hash) {
      findings.push({
        invariant: "months.closed-unchanged",
        key: `closed-changed:${kind}:${key}`,
        group: `closed-changed:${kind}`,
        message: `A closed month's ${kind} (${key}) changed since the last check.`,
      });
    }
  }
  return findings;
}

export function checksumMap(rows: ChecksumRow[]): Record<string, string> {
  return Object.fromEntries(rows.map((r) => [`${r.tenant}/${r.employee}/${r.month}`, r.hash]));
}

export const closedMonthsUnchanged: Invariant = {
  id: "months.closed-unchanged",
  title: "Closed months are unchanged since the last check",
  mayBeEmpty: true,
  async run(ctx) {
    const entries = checksumMap((await ctx.db.query<ChecksumRow>(ENTRY_CHECKSUMS)).rows);
    const snapshots = checksumMap((await ctx.db.query<ChecksumRow>(SNAPSHOT_CHECKSUMS)).rows);
    const findings = [
      ...compareChecksums("entries", ctx.checksums.entries, entries),
      ...compareChecksums("snapshots", ctx.checksums.snapshots, snapshots),
    ];
    // The baseline for the next run is what this run saw. The caller persists it.
    ctx.nextChecksums = { entries, snapshots };
    return result(
      closedMonthsUnchanged,
      Object.keys(entries).length + Object.keys(snapshots).length,
      findings,
    );
  },
};

// ── 4. every change has an audit entry ────────────────────────────────────────

export const auditCoverage: Invariant = {
  id: "audit.coverage",
  title: "Every created or changed entry and request has an audit entry",
  async run(ctx) {
    const findings: Finding[] = [];
    let examined = 0;
    for (const entity of ["TimeEntry", "LeaveRequest"] as const) {
      const table = `"${entity}"`;
      const created = await ctx.db.query<{ id: string }>(
        `SELECT t."id" FROM ${table} t
          WHERE t."createdAt" >= $1
            AND NOT EXISTS (SELECT 1 FROM "AuditLog" a WHERE a."entity" = $2 AND a."entityId" = t."id")`,
        [ctx.since, entity],
      );
      const changed = await ctx.db.query<{ id: string }>(
        `SELECT t."id" FROM ${table} t
          WHERE t."updatedAt" >= $1 AND t."updatedAt" > t."createdAt" + interval '2 seconds'
            AND NOT EXISTS (SELECT 1 FROM "AuditLog" a
                             WHERE a."entity" = $2 AND a."entityId" = t."id"
                               AND a."createdAt" >= t."updatedAt" - interval '10 seconds')`,
        [ctx.since, entity],
      );
      // Counts every row of the table, not only the window: a quiet night is legitimate, a table
      // the check can no longer see is not (the runner turns "examined nothing" into a finding).
      examined += await count(ctx.db, `SELECT count(*) AS n FROM ${table}`);
      for (const row of created.rows) {
        findings.push({
          invariant: "audit.coverage",
          key: `audit-missing-create:${entity}:${row.id}`,
          group: `audit-missing-create:${entity}`,
          message: `${entity} ${row.id} was created without any audit entry.`,
        });
      }
      for (const row of changed.rows) {
        findings.push({
          invariant: "audit.coverage",
          key: `audit-missing-change:${entity}:${row.id}`,
          group: `audit-missing-change:${entity}`,
          message: `${entity} ${row.id} was changed without a matching audit entry.`,
        });
      }
    }
    return result(auditCoverage, examined, findings);
  },
};

// ── 5. tenant separation in the data itself ───────────────────────────────────

export const tenantReferences: Invariant = {
  id: "tenant.references",
  title: "Rows only reference salons of their own tenant",
  async run(ctx) {
    const entries = await ctx.db.query<{ id: string }>(
      `SELECT t."id" FROM "TimeEntry" t
         JOIN "Employee" e ON e."id" = t."employeeId" JOIN "Salon" s ON s."id" = t."salonId"
        WHERE s."tenantId" <> e."tenantId"`,
    );
    const shifts = await ctx.db.query<{ id: string }>(
      `SELECT h."id" FROM "Shift" h
         JOIN "Employee" e ON e."id" = h."employeeId" JOIN "Salon" s ON s."id" = h."salonId"
        WHERE s."tenantId" <> e."tenantId"`,
    );
    const examined =
      (await count(ctx.db, `SELECT count(*) AS n FROM "TimeEntry"`)) +
      (await count(ctx.db, `SELECT count(*) AS n FROM "Shift"`));
    return result(tenantReferences, examined, [
      ...entries.rows.map((r) => ({
        key: `tenant-ref:TimeEntry:${r.id}`,
        group: "tenant-ref:TimeEntry",
        message: `TimeEntry ${r.id} references a salon of another tenant.`,
      })),
      ...shifts.rows.map((r) => ({
        key: `tenant-ref:Shift:${r.id}`,
        group: "tenant-ref:Shift",
        message: `Shift ${r.id} references a salon of another tenant.`,
      })),
    ]);
  },
};

// ── helpers ───────────────────────────────────────────────────────────────────

function windowStart(ctx: CheckContext): string {
  const [y, m, d] = ctx.today.split("-").map(Number);
  return new Date(Date.UTC(y, m - 1, d - 120)).toISOString().slice(0, 10);
}

export function result(
  invariant: Pick<Invariant, "id" | "title">,
  examined: number,
  found: { key: string; group?: string; message: string }[],
): InvariantResult {
  return {
    id: invariant.id,
    title: invariant.title,
    examined,
    findings: found.map((f) => ({ invariant: invariant.id, ...f })),
  };
}

export const DB_INVARIANTS: Invariant[] = [
  noOverlap,
  singleOpenPerDay,
  closedMonthsUnchanged,
  auditCoverage,
  tenantReferences,
];

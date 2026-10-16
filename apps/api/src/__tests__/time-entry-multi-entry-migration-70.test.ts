/**
 * Issue #70 (Phase 70b-05, AC-70-5, D-05) — the two 70b migrations change no saldo and leave the
 * catalog exactly as planned.
 *
 * Executes the REAL migration texts (never a restatement of them): both files are resolved by the
 * hard-coded directory constants below (never a directory listing), and the replay runs inside a
 * `$transaction` that always ends by throwing a module-private sentinel, so nothing the replay does
 * lands in the shared test database. Same technique as `time-entry-activity-migration-81.test.ts`
 * (Phase 81): assertions run AFTER the rejection, on values captured outside the callback (an
 * assertion failure inside the callback would be masked by the rollback).
 *
 * The migrated test database already has the new objects, so the replay first drops them INSIDE the
 * rolled-back transaction (Postgres DDL is transactional) and recreates the legacy partial unique
 * index of 20260707092711 — the shape before #70. The DDL holds an ACCESS EXCLUSIVE lock on
 * "TimeEntry" until the transaction ends: no `app.inject` and no read on another connection while
 * it is open.
 *
 * Cases: (1) the generated migration is exactly the plain index, (2) the hand-written one is exactly
 * the four planned statements of the chosen path, (3) the catalog holds exactly the planned objects,
 * (4) replaying both migrations on the legacy shape, over a legacy dataset (one entry per employee
 * and day, two months, a midnight-spanning entry, a closed month with its snapshot), leaves every
 * saldo input and every snapshot byte-identical and the statements raise nothing — the dataset
 * satisfies the new rules (D-05).
 *
 * No person names in fixtures.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import type { FastifyInstance } from "fastify";
import { getTestApp, seedTestData, cleanupTestData } from "./setup";

// __dirname is apps/api/src/__tests__ — four levels up is the repo root.
const REPO_ROOT = join(__dirname, "..", "..", "..", "..");
const MIGRATIONS_DIR = join(REPO_ROOT, "packages/db/prisma/migrations");
const INDEX_MIGRATION_DIR = "20261016130000_time_entry_multi_entry_per_day";
const OVERLAP_MIGRATION_DIR = "20261016130001_time_entry_no_overlap";

/** Thrown at the end of the replay transaction so the legacy-shape DDL always rolls back. */
class MultiEntryMigrationReplayRollback extends Error {}

function readMigration(dir: string): string {
  return readFileSync(join(MIGRATIONS_DIR, dir, "migration.sql"), "utf8");
}

/** Comment-only lines removed, then split on a semicolon that ends a line (the terminator). */
function splitStatements(sql: string): string[] {
  const withoutComments = sql
    .split("\n")
    .filter((line) => !line.trim().startsWith("--"))
    .join("\n");
  return withoutComments
    .split(/;\s*\n/)
    .map((s) => s.trim().replace(/\s+/g, " "))
    .filter((s) => s.length > 0);
}

/** The partial unique index of 20260707092711, i.e. the shape before #70. */
const LEGACY_UNIQUE_INDEX_SQL = `CREATE UNIQUE INDEX "TimeEntry_employeeId_date_unique_not_deleted" ON "TimeEntry"("employeeId", "date") WHERE "deletedAt" IS NULL`;

describe("migration texts (D-01, D-10)", () => {
  it("the generated migration is exactly the plain (employeeId, date) index", () => {
    const statements = splitStatements(readMigration(INDEX_MIGRATION_DIR));
    expect(statements).toEqual([
      `CREATE INDEX "TimeEntry_employeeId_date_idx" ON "TimeEntry"("employeeId", "date")`,
    ]);
  });

  it("the hand-written migration is exactly the four planned statements of path A", () => {
    const sql = readMigration(OVERLAP_MIGRATION_DIR);
    // The chosen path is the exclusion constraint (70b-SPIKE, CHOSEN_PATH=A). A trigger variant would
    // need its own proof here — fail loudly instead of silently proving the wrong thing.
    expect(sql, "path A: exclusion constraint").toContain("EXCLUDE USING gist");
    expect(sql, "no trigger path in the chosen migration").not.toMatch(
      /CREATE\s+(OR REPLACE\s+)?(TRIGGER|FUNCTION)/i,
    );
    expect(splitStatements(sql)).toEqual([
      `DROP INDEX "TimeEntry_employeeId_date_unique_not_deleted"`,
      `CREATE EXTENSION IF NOT EXISTS btree_gist`,
      `ALTER TABLE "TimeEntry" ADD CONSTRAINT "TimeEntry_no_overlap_closed" EXCLUDE USING gist ("employeeId" WITH =, tstzrange("startTime", "endTime", '[)') WITH &&) WHERE ("deletedAt" IS NULL AND "endTime" IS NOT NULL)`,
      `CREATE UNIQUE INDEX "TimeEntry_employeeId_date_open_unique" ON "TimeEntry"("employeeId", "date") WHERE "deletedAt" IS NULL AND "endTime" IS NULL`,
    ]);
  });

  it("neither migration updates, deletes or inserts a row", () => {
    for (const dir of [INDEX_MIGRATION_DIR, OVERLAP_MIGRATION_DIR]) {
      const statements = splitStatements(readMigration(dir));
      expect(statements.length, dir).toBeGreaterThan(0);
      for (const statement of statements) {
        expect(statement, dir).not.toMatch(/^(UPDATE|DELETE|INSERT|TRUNCATE)\b/i);
      }
    }
  });
});

describe("Issue #70 — migration catalog and replay neutrality", () => {
  let app: FastifyInstance;
  let data: Awaited<ReturnType<typeof seedTestData>>;
  let other: Awaited<ReturnType<typeof seedTestData>>;

  beforeAll(async () => {
    app = await getTestApp();
    data = await seedTestData(app, "mig70");
    other = await seedTestData(app, "mig70-b");

    // Legacy dataset: exactly one live entry per employee and day, in the shape the pre-#70
    // world could hold. Inserted through the MIGRATED schema — which is the first half of "the
    // dataset satisfies the new rules" (a violating row would be refused here already).
    const entry = (
      employeeId: string,
      salonId: string,
      date: string,
      start: string,
      end: string | null,
      extra: Record<string, unknown> = {},
    ) =>
      app.prisma.timeEntry.create({
        data: {
          employeeId,
          salonId,
          date: new Date(`${date}T00:00:00Z`),
          startTime: new Date(start),
          endTime: end ? new Date(end) : null,
          source: "MANUAL",
          breakMinutes: 30,
          ...extra,
        },
      });

    for (const tenantSeed of [data, other]) {
      const employees = [tenantSeed.employee.id, tenantSeed.adminEmployee.id];
      for (const employeeId of employees) {
        // February (closed below) and March, working weekdays 2026, 08:00-16:30 UTC.
        for (const day of ["2026-02-10", "2026-02-11", "2026-02-12", "2026-03-10", "2026-03-11"]) {
          await entry(employeeId, tenantSeed.salonId, day, `${day}T08:00:00Z`, `${day}T16:30:00Z`);
        }
        // A midnight-spanning night entry: date 2026-03-13, ends on the 14th.
        await entry(
          employeeId,
          tenantSeed.salonId,
          "2026-03-13",
          "2026-03-13T21:00:00Z",
          "2026-03-14T05:00:00Z",
        );
        // An invalid and a soft-deleted entry of an own day each (neither counts for the saldo).
        await entry(
          employeeId,
          tenantSeed.salonId,
          "2026-03-16",
          "2026-03-16T08:00:00Z",
          "2026-03-16T12:00:00Z",
          { isInvalid: true, invalidReason: "mig70" },
        );
        await entry(
          employeeId,
          tenantSeed.salonId,
          "2026-03-17",
          "2026-03-17T08:00:00Z",
          "2026-03-17T12:00:00Z",
          { deletedAt: new Date("2026-03-18T00:00:00Z") },
        );
      }
      // A running entry of a day that is its employee's only one (an open row is legal legacy data).
      await entry(
        tenantSeed.employee.id,
        tenantSeed.salonId,
        "2026-03-20",
        "2026-03-20T08:00:00Z",
        null,
        { breakMinutes: 0 },
      );
      const lastEntry = await app.prisma.timeEntry.findFirstOrThrow({
        where: { employeeId: tenantSeed.employee.id, date: new Date("2026-02-10T00:00:00Z") },
      });
      await app.prisma.break.create({
        data: {
          timeEntryId: lastEntry.id,
          startTime: new Date("2026-02-10T12:00:00Z"),
          endTime: new Date("2026-02-10T12:30:00Z"),
        },
      });
    }

    // Saldo-side rows the migration must not touch: a closed month with its snapshot, an account.
    for (const employeeId of [data.employee.id, data.adminEmployee.id]) {
      await app.prisma.saldoSnapshot.create({
        data: {
          employeeId,
          periodType: "MONTHLY",
          periodStart: new Date("2026-02-01"),
          periodEnd: new Date("2026-02-28"),
          workedMinutes: 1440,
          expectedMinutes: 1500,
          balanceMinutes: -60,
          carryOver: -60,
          closedAt: new Date("2026-03-01T00:00:00Z"),
        },
      });
      await app.prisma.overtimeAccount.upsert({
        where: { employeeId },
        update: { balanceHours: 4 },
        create: { employeeId, balanceHours: 4 },
      });
    }
  });

  afterAll(async () => {
    for (const tenant of [data, other]) {
      try {
        await cleanupTestData(app, tenant.tenant.id);
      } catch (err) {
        console.error("Test cleanup failed:", err);
      }
    }
  });

  it("the catalog holds exactly the planned objects", async () => {
    // btree_gist exists.
    const ext = await app.prisma.$queryRaw<{ extname: string }[]>`
      SELECT extname FROM pg_extension WHERE extname = 'btree_gist'`;
    expect(ext).toEqual([{ extname: "btree_gist" }]);

    // Exactly one exclusion constraint on TimeEntry: the planned one.
    const exclusions = await app.prisma.$queryRaw<{ conname: string; def: string }[]>`
      SELECT conname, pg_get_constraintdef(oid) AS def FROM pg_constraint
      WHERE conrelid = '"TimeEntry"'::regclass AND contype = 'x'`;
    expect(exclusions).toHaveLength(1);
    expect(exclusions[0].conname).toBe("TimeEntry_no_overlap_closed");
    const def = exclusions[0].def.replace(/\s+/g, " ");
    expect(def).toContain("EXCLUDE USING gist");
    expect(def).toContain(`"employeeId" WITH =`);
    expect(def).toContain(`tstzrange("startTime", "endTime", '[)'::text) WITH &&`);
    expect(def).toContain(`"deletedAt" IS NULL`);
    expect(def).toContain(`"endTime" IS NOT NULL`);

    // The partial unique index: one OPEN, live entry per employee and day.
    const open = await app.prisma.$queryRaw<{ indexdef: string }[]>`
      SELECT indexdef FROM pg_indexes
      WHERE tablename = 'TimeEntry' AND indexname = 'TimeEntry_employeeId_date_open_unique'`;
    expect(open).toHaveLength(1);
    const openDef = open[0].indexdef.replace(/\s+/g, " ");
    expect(openDef).toContain("CREATE UNIQUE INDEX");
    expect(openDef).toContain(`("employeeId", date)`);
    expect(openDef).toContain(`"deletedAt" IS NULL`);
    expect(openDef).toContain(`"endTime" IS NULL`);

    // The plain (employeeId, date) index is back, and it is NOT unique.
    const plain = await app.prisma.$queryRaw<{ indexdef: string }[]>`
      SELECT indexdef FROM pg_indexes
      WHERE tablename = 'TimeEntry' AND indexname = 'TimeEntry_employeeId_date_idx'`;
    expect(plain).toHaveLength(1);
    expect(plain[0].indexdef).not.toContain("UNIQUE");
    expect(plain[0].indexdef).toContain(`("employeeId", date)`);

    // The index the old rule lived in is gone.
    const gone = await app.prisma.$queryRaw<{ n: bigint }[]>`
      SELECT count(*) AS n FROM pg_indexes
      WHERE indexname = 'TimeEntry_employeeId_date_unique_not_deleted'`;
    expect(Number(gone[0].n)).toBe(0);

    // No trigger of this phase (path A needs none).
    const triggers = await app.prisma.$queryRaw<{ n: bigint }[]>`
      SELECT count(*) AS n FROM pg_trigger
      WHERE tgrelid = '"TimeEntry"'::regclass AND NOT tgisinternal`;
    expect(Number(triggers[0].n)).toBe(0);
  });

  it("the legacy dataset satisfies the new rules (D-05)", async () => {
    // No two live closed entries of one employee overlap, no employee-day has two open rows.
    const overlaps = await app.prisma.$queryRaw<{ n: bigint }[]>`
      SELECT count(*) AS n FROM "TimeEntry" a JOIN "TimeEntry" b
        ON a."employeeId" = b."employeeId" AND a."id" < b."id"
       AND a."deletedAt" IS NULL AND b."deletedAt" IS NULL
       AND a."endTime" IS NOT NULL AND b."endTime" IS NOT NULL
       AND tstzrange(a."startTime", a."endTime", '[)') && tstzrange(b."startTime", b."endTime", '[)')
      WHERE a."employeeId" IN (
        SELECT "id" FROM "Employee" WHERE "tenantId" IN (${data.tenant.id}, ${other.tenant.id}))`;
    expect(Number(overlaps[0].n)).toBe(0);
    const total = await app.prisma.timeEntry.count({
      where: { employee: { tenantId: { in: [data.tenant.id, other.tenant.id] } } },
    });
    expect(total, "the dataset must contain rows (vacuity guard)").toBe(34);
  });

  it("replays both real migrations on the legacy shape without moving any saldo input (AC-70-5)", async () => {
    const indexStatements = splitStatements(readMigration(INDEX_MIGRATION_DIR));
    const overlapStatements = splitStatements(readMigration(OVERLAP_MIGRATION_DIR));
    expect(indexStatements).toHaveLength(1);
    expect(overlapStatements).toHaveLength(4);
    const tenantIds = [data.tenant.id, other.tenant.id];

    type Hashes = Record<string, string>;
    async function hashes(tx: {
      $queryRawUnsafe: <T>(q: string, ...v: unknown[]) => Promise<T>;
    }): Promise<{ hashes: Hashes; rowCounts: Record<string, number> }> {
      const sources: Record<string, string> = {
        entries: `SELECT t::text AS r, t."id" AS k FROM "TimeEntry" t JOIN "Employee" e ON e."id" = t."employeeId" WHERE e."tenantId" = ANY($1::text[])`,
        breaks: `SELECT b::text AS r, b."id" AS k FROM "Break" b JOIN "TimeEntry" t ON t."id" = b."timeEntryId" JOIN "Employee" e ON e."id" = t."employeeId" WHERE e."tenantId" = ANY($1::text[])`,
        snapshots: `SELECT s::text AS r, s."id" AS k FROM "SaldoSnapshot" s JOIN "Employee" e ON e."id" = s."employeeId" WHERE e."tenantId" = ANY($1::text[])`,
        accounts: `SELECT a::text AS r, a."id" AS k FROM "OvertimeAccount" a JOIN "Employee" e ON e."id" = a."employeeId" WHERE e."tenantId" = ANY($1::text[])`,
        schedules: `SELECT w::text AS r, w."id" AS k FROM "WorkSchedule" w JOIN "Employee" e ON e."id" = w."employeeId" WHERE e."tenantId" = ANY($1::text[])`,
        employees: `SELECT e::text AS r, e."id" AS k FROM "Employee" e WHERE e."tenantId" = ANY($1::text[])`,
      };
      const out: Hashes = {};
      const rowCounts: Record<string, number> = {};
      for (const [name, query] of Object.entries(sources)) {
        const rows = await tx.$queryRawUnsafe<{ h: string; n: bigint }[]>(
          `SELECT md5(coalesce(string_agg(q.r, '|' ORDER BY q.k), '')) AS h, count(*) AS n FROM (${query}) q`,
          tenantIds,
        );
        out[name] = rows[0].h;
        rowCounts[name] = Number(rows[0].n);
      }
      return { hashes: out, rowCounts };
    }

    let legacyShape = false;
    let before: Awaited<ReturnType<typeof hashes>> | undefined;
    let after: Awaited<ReturnType<typeof hashes>> | undefined;
    let migratedShape = false;
    let controlSensitive = false;

    async function catalogCounts(tx: {
      $queryRawUnsafe: <T>(q: string, ...v: unknown[]) => Promise<T>;
    }) {
      const rows = await tx.$queryRawUnsafe<{ name: string; n: bigint }[]>(
        `SELECT 'constraint' AS name, count(*) AS n FROM pg_constraint
           WHERE conrelid = '"TimeEntry"'::regclass AND conname = 'TimeEntry_no_overlap_closed'
         UNION ALL SELECT 'open', count(*) FROM pg_indexes WHERE indexname = 'TimeEntry_employeeId_date_open_unique'
         UNION ALL SELECT 'plain', count(*) FROM pg_indexes WHERE indexname = 'TimeEntry_employeeId_date_idx'
         UNION ALL SELECT 'old', count(*) FROM pg_indexes WHERE indexname = 'TimeEntry_employeeId_date_unique_not_deleted'`,
      );
      return Object.fromEntries(rows.map((r) => [r.name, Number(r.n)]));
    }

    await expect(
      app.prisma.$transaction(
        async (tx) => {
          // Recreate the pre-#70 shape: the new objects out, the legacy partial unique index in.
          await tx.$executeRawUnsafe(
            `ALTER TABLE "TimeEntry" DROP CONSTRAINT "TimeEntry_no_overlap_closed"`,
          );
          await tx.$executeRawUnsafe(`DROP INDEX "TimeEntry_employeeId_date_open_unique"`);
          await tx.$executeRawUnsafe(`DROP INDEX "TimeEntry_employeeId_date_idx"`);
          await tx.$executeRawUnsafe(`DROP EXTENSION btree_gist`);
          await tx.$executeRawUnsafe(LEGACY_UNIQUE_INDEX_SQL);
          const legacy = await catalogCounts(tx);
          legacyShape =
            legacy.constraint === 0 && legacy.open === 0 && legacy.plain === 0 && legacy.old === 1;

          before = await hashes(tx);
          // The statements of both REAL migrations, in directory order; any row they cannot
          // accept would raise here (ADD CONSTRAINT validates every existing row).
          for (const statement of [...indexStatements, ...overlapStatements]) {
            await tx.$executeRawUnsafe(statement);
          }
          after = await hashes(tx);

          const migrated = await catalogCounts(tx);
          migratedShape =
            migrated.constraint === 1 &&
            migrated.open === 1 &&
            migrated.plain === 1 &&
            migrated.old === 0;

          // Control: the comparison is sensitive — one changed saldo input moves the hash.
          await tx.$executeRawUnsafe(
            `UPDATE "TimeEntry" SET "breakMinutes" = "breakMinutes" + 1 WHERE "id" = (
               SELECT t."id" FROM "TimeEntry" t JOIN "Employee" e ON e."id" = t."employeeId"
               WHERE e."tenantId" = ANY($1::text[]) ORDER BY t."id" LIMIT 1)`,
            tenantIds,
          );
          const touched = await hashes(tx);
          controlSensitive = touched.hashes.entries !== after.hashes.entries;
          throw new MultiEntryMigrationReplayRollback();
        },
        { timeout: 30_000 },
      ),
    ).rejects.toThrow(MultiEntryMigrationReplayRollback);

    expect(legacyShape, "the legacy shape was recreated before the replay").toBe(true);
    expect(before).toBeDefined();
    expect(after).toBeDefined();
    // Every saldo input and every snapshot is byte-identical across the replay.
    expect(after!.hashes).toEqual(before!.hashes);
    expect(after!.rowCounts).toEqual(before!.rowCounts);
    expect(migratedShape, "the replay produced the migrated shape").toBe(true);
    expect(controlSensitive, "a changed row moves the hash (the comparison is not vacuous)").toBe(
      true,
    );
    // Vacuity guard: every compared group really held rows.
    for (const group of ["entries", "breaks", "snapshots", "accounts", "schedules", "employees"]) {
      expect(before!.rowCounts[group], `group ${group} is non-empty`).toBeGreaterThan(0);
    }
    // 2 tenants x (2 employees x 8 entries + 1 running entry), one Break row per tenant, one
    // snapshot per employee of the first tenant.
    expect(before!.rowCounts.entries).toBe(34);
    expect(before!.rowCounts.breaks).toBe(2);
    expect(before!.rowCounts.snapshots).toBe(2);

    // Rollback proof: the migrated shape is back for every other file.
    const col = await app.prisma.$queryRaw<{ n: bigint }[]>`
      SELECT count(*) AS n FROM pg_constraint
      WHERE conrelid = '"TimeEntry"'::regclass AND conname = 'TimeEntry_no_overlap_closed'`;
    const ext = await app.prisma.$queryRaw<{ n: bigint }[]>`
      SELECT count(*) AS n FROM pg_extension WHERE extname = 'btree_gist'`;
    expect(Number(col[0].n)).toBe(1);
    expect(Number(ext[0].n)).toBe(1);
  });
});

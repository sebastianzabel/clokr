/**
 * Issue #92 (Phase 92b-01, AC-92-8, D-02/D-05) — the three travel migrations are additive and
 * change no saldo input; the database refuses every wrong travel shape.
 *
 * Executes the REAL migration texts (never a restatement of them): the files are resolved by the
 * hard-coded directory constants below (never a directory listing), and the replay runs inside a
 * `$transaction` that always ends by throwing a module-private sentinel, so nothing the replay does
 * lands in the shared test database. Same technique as `time-entry-activity-migration-81.test.ts`
 * and `time-entry-multi-entry-migration-70.test.ts`: assertions run AFTER the rejection, on values
 * captured outside the callback (an assertion failure inside the callback would be masked by the
 * rollback).
 *
 * The enum file (`ALTER TYPE ... ADD VALUE`) is proven by TEXT and CATALOG only: a value cannot be
 * added to a database that already holds it, and an enum value cannot be dropped again. Its
 * execution proof is the replay of the whole migration chain on throwaway PostgreSQL 17 and 18
 * databases recorded in the phase's spike notes (92b-01 Task 1). The column file and the CHECK file
 * ARE replayed here, on the legacy shape recreated INSIDE the rolled-back transaction (Postgres DDL
 * is transactional). The DDL holds an ACCESS EXCLUSIVE lock on "TimeEntry" until the transaction
 * ends: no `app.inject` and no read on another connection while it is open.
 *
 * Cases: (1) migration texts, (2) the catalog holds exactly the planned objects, (3) the CHECK
 * refuses five wrong shapes (and three more) and accepts a well-formed row, with a mutation proof
 * that the refusals come from the constraint, (4) replaying the column and CHECK files on the legacy
 * shape leaves every saldo input (T1, T2, the raw rows) and every snapshot byte-identical.
 *
 * No person names in fixtures.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { inspect } from "node:util";
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import type { FastifyInstance } from "fastify";
import type { Prisma } from "@clokr/db";
import { getTestApp, seedTestData, cleanupTestData, createTestSalon } from "./setup";
import { getValidWorkedEntriesInRange, getWorkedEntriesInRange } from "../contexts/time-tracking";
import { accessContextForJob, employeeScopeFor } from "../contexts/platform";

// __dirname is apps/api/src/__tests__ — four levels up is the repo root.
const REPO_ROOT = join(__dirname, "..", "..", "..", "..");
const MIGRATIONS_DIR = join(REPO_ROOT, "packages/db/prisma/migrations");
const ENUM_MIGRATION_DIR = "20261016171900_activity_kind_travel";
const COLUMN_MIGRATION_DIR = "20261016171901_time_entry_travel_to_salon";
const CHECK_MIGRATION_DIR = "20261016171902_time_entry_travel_shape_check";

/** Thrown at the end of a transaction so its DDL and writes always roll back. */
class TravelMigrationRollback extends Error {}

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

const ALL_DIRS = [ENUM_MIGRATION_DIR, COLUMN_MIGRATION_DIR, CHECK_MIGRATION_DIR];

describe("migration texts (D-05)", () => {
  it("the enum file holds exactly one statement, the ADD VALUE", () => {
    expect(splitStatements(readMigration(ENUM_MIGRATION_DIR))).toEqual([
      `ALTER TYPE "ActivityKind" ADD VALUE 'TRAVEL'`,
    ]);
  });

  it("the column file is the nullable TEXT column, its index and its RESTRICT foreign key", () => {
    expect(splitStatements(readMigration(COLUMN_MIGRATION_DIR))).toEqual([
      `ALTER TABLE "TimeEntry" ADD COLUMN "travelToSalonId" TEXT`,
      `CREATE INDEX "TimeEntry_travelToSalonId_idx" ON "TimeEntry"("travelToSalonId")`,
      `ALTER TABLE "TimeEntry" ADD CONSTRAINT "TimeEntry_travelToSalonId_fkey" FOREIGN KEY ("travelToSalonId") REFERENCES "Salon"("id") ON DELETE RESTRICT ON UPDATE CASCADE`,
    ]);
  });

  it("the CHECK file is exactly one ALTER TABLE ... ADD CONSTRAINT ... CHECK, in a later file than the enum value", () => {
    const statements = splitStatements(readMigration(CHECK_MIGRATION_DIR));
    expect(statements).toHaveLength(1);
    expect(statements[0]).toMatch(
      /^ALTER TABLE "TimeEntry" ADD CONSTRAINT "TimeEntry_travel_shape_check" CHECK \(/,
    );
    // A new enum value cannot be used in the transaction that adds it, so the file using it sorts later.
    expect([...ALL_DIRS].sort()).toEqual(ALL_DIRS);
  });

  it("no file updates, deletes, drops, inserts or truncates", () => {
    for (const dir of ALL_DIRS) {
      const statements = splitStatements(readMigration(dir));
      expect(statements.length, dir).toBeGreaterThan(0);
      for (const statement of statements) {
        expect(statement, dir).not.toMatch(/^(UPDATE|DELETE|DROP|INSERT|TRUNCATE)\b/i);
      }
    }
  });
});

describe("Issue #92 — migration catalog, CHECK refusals and replay neutrality", () => {
  let app: FastifyInstance;
  let data: Awaited<ReturnType<typeof seedTestData>>;
  let other: Awaited<ReturnType<typeof seedTestData>>;
  // A third tenant of its own for the CHECK cases, so the persistent well-formed TRAVEL row below
  // never enters the legacy dataset the replay compares.
  let third: Awaited<ReturnType<typeof seedTestData>>;
  let salonB: { id: string };
  let fresh: { employeeId: string };

  beforeAll(async () => {
    app = await getTestApp();
    data = await seedTestData(app, "mig92");
    other = await seedTestData(app, "mig92-b");
    third = await seedTestData(app, "mig92-c");
    salonB = await createTestSalon(app.prisma, third.tenant.id, { name: "Salon B" });

    // Legacy dataset: ordinary entries in the shape the pre-#92 world could hold (no destination,
    // never TRAVEL), inserted through the MIGRATED schema.
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
      for (const employeeId of [tenantSeed.employee.id, tenantSeed.adminEmployee.id]) {
        // February (closed below) and March.
        for (const day of ["2026-02-10", "2026-02-11", "2026-03-10", "2026-03-11"]) {
          await entry(employeeId, tenantSeed.salonId, day, `${day}T08:00:00Z`, `${day}T16:30:00Z`);
        }
        // A classified entry and an invalid one (neither changes with the migration).
        await entry(
          employeeId,
          tenantSeed.salonId,
          "2026-03-12",
          "2026-03-12T08:00:00Z",
          "2026-03-12T12:00:00Z",
          { activityKind: "PRODUCTIVE" },
        );
        await entry(
          employeeId,
          tenantSeed.salonId,
          "2026-03-16",
          "2026-03-16T08:00:00Z",
          "2026-03-16T12:00:00Z",
          { isInvalid: true, invalidReason: "mig92" },
        );
      }
      // A running entry (an open row is legal legacy data).
      await entry(
        tenantSeed.employee.id,
        tenantSeed.salonId,
        "2026-03-20",
        "2026-03-20T08:00:00Z",
        null,
        { breakMinutes: 0 },
      );
      const withBreak = await app.prisma.timeEntry.findFirstOrThrow({
        where: { employeeId: tenantSeed.employee.id, date: new Date("2026-02-10T00:00:00Z") },
      });
      await app.prisma.break.create({
        data: {
          timeEntryId: withBreak.id,
          startTime: new Date("2026-02-10T12:00:00Z"),
          endTime: new Date("2026-02-10T12:30:00Z"),
        },
      });
    }

    // Saldo-side rows the migrations must not touch: a closed month with its snapshot, an account.
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

    // The employee the CHECK refusals write for: no other row, so only the constraint can refuse.
    fresh = { employeeId: third.adminEmployee.id };
  });

  afterAll(async () => {
    for (const tenant of [data, other, third]) {
      try {
        await cleanupTestData(app, tenant.tenant.id);
      } catch (err) {
        console.error("Test cleanup failed:", err);
      }
    }
  });

  it("the catalog holds exactly the planned objects", async () => {
    const labels = await app.prisma.$queryRaw<{ enumlabel: string }[]>`
      SELECT e.enumlabel FROM pg_enum e JOIN pg_type t ON t.oid = e.enumtypid
      WHERE t.typname = 'ActivityKind' ORDER BY e.enumsortorder`;
    expect(labels.map((l) => l.enumlabel)).toEqual([
      "UNSPECIFIED",
      "PRODUCTIVE",
      "SETUP_CLEANING",
      "TRAVEL",
    ]);

    const col = await app.prisma.$queryRaw<
      { is_nullable: string; data_type: string; column_default: string | null }[]
    >`
      SELECT is_nullable, data_type, column_default FROM information_schema.columns
      WHERE table_name = 'TimeEntry' AND column_name = 'travelToSalonId'`;
    expect(col).toEqual([{ is_nullable: "YES", data_type: "text", column_default: null }]);

    const fk = await app.prisma.$queryRaw<{ del: string; target: string }[]>`
      SELECT confdeltype::text AS del, confrelid::regclass::text AS target FROM pg_constraint
      WHERE conname = 'TimeEntry_travelToSalonId_fkey' AND contype = 'f'`;
    expect(fk).toEqual([{ del: "r", target: '"Salon"' }]);

    const idx = await app.prisma.$queryRaw<{ n: bigint }[]>`
      SELECT count(*) AS n FROM pg_indexes
      WHERE tablename = 'TimeEntry' AND indexname = 'TimeEntry_travelToSalonId_idx'`;
    expect(Number(idx[0].n)).toBe(1);

    const check = await app.prisma.$queryRaw<{ def: string }[]>`
      SELECT pg_get_constraintdef(oid) AS def FROM pg_constraint
      WHERE conrelid = '"TimeEntry"'::regclass AND conname = 'TimeEntry_travel_shape_check'`;
    expect(check).toHaveLength(1);
    const def = check[0].def.replace(/\s+/g, " ");
    // The pairing, the different-salon, the WORK, the closed and the zero-break clause.
    expect(def).toContain(`("activityKind" = 'TRAVEL'::"ActivityKind")`);
    expect(def).toContain(`("travelToSalonId" IS NOT NULL)`);
    expect(def).toContain(`("travelToSalonId" <> "salonId")`);
    expect(def).toContain(`(type = 'WORK'::"TimeEntryType")`);
    expect(def).toContain(`("endTime" IS NOT NULL)`);
    expect(def).toContain(`("endTime" > "startTime")`);
    expect(def).toContain(`("breakMinutes" = 0)`);
  });

  describe("the CHECK refuses every wrong shape and accepts the right one", () => {
    const day = "2026-04-07";
    const at = (hhmm: string) => new Date(`${day}T${hhmm}:00Z`);

    /** A write that must be refused by the constraint; the count proves nothing was written. */
    async function expectRefused(label: string, row: Record<string, unknown>) {
      const before = await app.prisma.timeEntry.count({ where: { employeeId: fresh.employeeId } });
      let message = "";
      try {
        await app.prisma.timeEntry.create({
          data: {
            employeeId: fresh.employeeId,
            salonId: third.salonId,
            date: new Date(`${day}T00:00:00Z`),
            startTime: at("12:00"),
            endTime: at("12:30"),
            source: "MANUAL",
            breakMinutes: 0,
            ...row,
          },
        });
      } catch (err) {
        message = inspect(err, { depth: 10 });
      }
      expect(message, `${label}: the write is refused`).toContain("TimeEntry_travel_shape_check");
      expect(await app.prisma.timeEntry.count({ where: { employeeId: fresh.employeeId } })).toBe(
        before,
      );
    }

    it("refuses TRAVEL without a destination", async () => {
      await expectRefused("TRAVEL without destination", { activityKind: "TRAVEL" });
    });

    it("refuses a non-TRAVEL row with a destination", async () => {
      await expectRefused("destination on an ordinary row", { travelToSalonId: salonB.id });
    });

    it("refuses a destination equal to the departure salon", async () => {
      await expectRefused("same salon", { activityKind: "TRAVEL", travelToSalonId: third.salonId });
    });

    it("refuses an open TRAVEL row", async () => {
      await expectRefused("open travel row", {
        activityKind: "TRAVEL",
        travelToSalonId: salonB.id,
        endTime: null,
      });
    });

    it("refuses a TRAVEL row with break minutes", async () => {
      await expectRefused("travel with break", {
        activityKind: "TRAVEL",
        travelToSalonId: salonB.id,
        breakMinutes: 15,
      });
    });

    it("refuses a TRAVEL row that is not WORK and one that does not end after it starts", async () => {
      await expectRefused("travel of type OVERTIME", {
        activityKind: "TRAVEL",
        travelToSalonId: salonB.id,
        type: "OVERTIME",
      });
      await expectRefused("travel that ends where it starts", {
        activityKind: "TRAVEL",
        travelToSalonId: salonB.id,
        endTime: at("12:00"),
      });
    });

    it("accepts a well-formed TRAVEL row", async () => {
      // Written inside a transaction that always rolls back: a persistent TRAVEL row would be a row
      // the replay below cannot recreate the legacy shape for (the DDL acts on the whole table).
      let created: { activityKind: string; travelToSalonId: string | null } | undefined;
      await expect(
        app.prisma.$transaction(async (tx) => {
          created = await tx.timeEntry.create({
            data: {
              employeeId: fresh.employeeId,
              salonId: third.salonId,
              date: new Date(`${day}T00:00:00Z`),
              startTime: at("12:00"),
              endTime: at("12:30"),
              source: "MANUAL",
              breakMinutes: 0,
              activityKind: "TRAVEL",
              travelToSalonId: salonB.id,
            },
          });
          throw new TravelMigrationRollback();
        }),
      ).rejects.toThrow(TravelMigrationRollback);
      expect(created?.activityKind).toBe("TRAVEL");
      expect(created?.travelToSalonId).toBe(salonB.id);
      expect(
        await app.prisma.timeEntry.count({ where: { employeeId: fresh.employeeId } }),
        "the accepted row rolled back",
      ).toBe(0);
    });

    it("mutation proof: with the constraint dropped the wrong shapes are accepted, and it is back after the rollback", async () => {
      const accepted: string[] = [];
      let constraintsInside = -1;
      await expect(
        app.prisma.$transaction(
          async (tx) => {
            await tx.$executeRawUnsafe(
              `ALTER TABLE "TimeEntry" DROP CONSTRAINT "TimeEntry_travel_shape_check"`,
            );
            const inside = await tx.$queryRawUnsafe<{ n: bigint }[]>(
              `SELECT count(*) AS n FROM pg_constraint
               WHERE conrelid = '"TimeEntry"'::regclass AND conname = 'TimeEntry_travel_shape_check'`,
            );
            constraintsInside = Number(inside[0].n);
            const base = {
              employeeId: fresh.employeeId,
              salonId: third.salonId,
              date: new Date(`${day}T00:00:00Z`),
              source: "MANUAL" as const,
              breakMinutes: 0,
            };
            // Two wrong shapes that sit on free intervals of the day.
            await tx.timeEntry.create({
              data: {
                ...base,
                startTime: at("13:00"),
                endTime: at("13:30"),
                activityKind: "TRAVEL",
              },
            });
            accepted.push("TRAVEL without destination");
            await tx.timeEntry.create({
              data: {
                ...base,
                startTime: at("14:00"),
                endTime: at("14:30"),
                travelToSalonId: salonB.id,
              },
            });
            accepted.push("destination on an ordinary row");
            throw new TravelMigrationRollback();
          },
          { timeout: 30_000 },
        ),
      ).rejects.toThrow(TravelMigrationRollback);

      expect(constraintsInside, "the constraint was dropped inside the transaction").toBe(0);
      expect(accepted).toEqual(["TRAVEL without destination", "destination on an ordinary row"]);
      const back = await app.prisma.$queryRaw<{ n: bigint }[]>`
        SELECT count(*) AS n FROM pg_constraint
        WHERE conrelid = '"TimeEntry"'::regclass AND conname = 'TimeEntry_travel_shape_check'`;
      expect(Number(back[0].n)).toBe(1);
      expect(
        await app.prisma.timeEntry.count({
          where: { employeeId: fresh.employeeId, startTime: { in: [at("13:00"), at("14:00")] } },
        }),
        "the mutation rows rolled back",
      ).toBe(0);
    });
  });

  it("replays the column and CHECK files on the legacy shape without moving any saldo input (AC-92-8)", async () => {
    const columnStatements = splitStatements(readMigration(COLUMN_MIGRATION_DIR));
    const checkStatements = splitStatements(readMigration(CHECK_MIGRATION_DIR));
    expect(columnStatements).toHaveLength(3);
    expect(checkStatements).toHaveLength(1);
    const tenantIds = [data.tenant.id, other.tenant.id];
    const employeeIds = [
      data.employee.id,
      data.adminEmployee.id,
      other.employee.id,
      other.adminEmployee.id,
    ];

    type Hashes = Record<string, string>;
    type Db = Prisma.TransactionClient;

    async function capture(tx: Db): Promise<{
      hashes: Hashes;
      rowCounts: Record<string, number>;
      kinds: string;
    }> {
      // The raw rows are compared WITHOUT the new column (the legacy shape does not have it).
      const sources: Record<string, string> = {
        entries: `SELECT (to_jsonb(t) - 'travelToSalonId')::text AS r, t."id" AS k FROM "TimeEntry" t JOIN "Employee" e ON e."id" = t."employeeId" WHERE e."tenantId" = ANY($1::text[])`,
        breaks: `SELECT b::text AS r, b."id" AS k FROM "Break" b JOIN "TimeEntry" t ON t."id" = b."timeEntryId" JOIN "Employee" e ON e."id" = t."employeeId" WHERE e."tenantId" = ANY($1::text[])`,
        snapshots: `SELECT s::text AS r, s."id" AS k FROM "SaldoSnapshot" s JOIN "Employee" e ON e."id" = s."employeeId" WHERE e."tenantId" = ANY($1::text[])`,
        accounts: `SELECT a::text AS r, a."id" AS k FROM "OvertimeAccount" a JOIN "Employee" e ON e."id" = a."employeeId" WHERE e."tenantId" = ANY($1::text[])`,
        schedules: `SELECT w::text AS r, w."id" AS k FROM "WorkSchedule" w JOIN "Employee" e ON e."id" = w."employeeId" WHERE e."tenantId" = ANY($1::text[])`,
        employees: `SELECT e::text AS r, e."id" AS k FROM "Employee" e WHERE e."tenantId" = ANY($1::text[])`,
      };
      const hashes: Hashes = {};
      const rowCounts: Record<string, number> = {};
      for (const [name, query] of Object.entries(sources)) {
        const rows = await tx.$queryRawUnsafe<{ h: string; n: bigint }[]>(
          `SELECT md5(coalesce(string_agg(q.r, '|' ORDER BY q.k), '')) AS h, count(*) AS n FROM (${query}) q`,
          tenantIds,
        );
        hashes[name] = rows[0].h;
        rowCounts[name] = Number(rows[0].n);
      }

      // The saldo's own reads: T1 (closed, valid WORK) and T2 (closed WORK), over two months
      // including the closed one, as calendar-day bounds (CLAUDE.md #493).
      const scope = employeeScopeFor(accessContextForJob(data.tenant.id, "travel-migration-92"), {
        employeeIds: employeeIds.slice(0, 2),
      });
      const scopeOther = employeeScopeFor(
        accessContextForJob(other.tenant.id, "travel-migration-92"),
        { employeeIds: employeeIds.slice(2) },
      );
      const facade: unknown[] = [];
      for (const s of [scope, scopeOther]) {
        for (const [from, to] of [
          ["2026-02-01", "2026-02-28"],
          ["2026-03-01", "2026-03-31"],
        ] as const) {
          const t1 = await getValidWorkedEntriesInRange(tx, s, new Date(from), new Date(to));
          const t2 = await getWorkedEntriesInRange(tx, s, new Date(from), new Date(to));
          facade.push(
            [...t1].sort((a, b) => a.id.localeCompare(b.id)),
            [...t2].sort((a, b) => a.id.localeCompare(b.id)),
          );
        }
      }
      hashes.facade = JSON.stringify(facade);
      rowCounts.facade = facade.length;

      const kinds = await tx.$queryRawUnsafe<{ k: string; n: bigint }[]>(
        `SELECT t."activityKind"::text AS k, count(*) AS n FROM "TimeEntry" t
         JOIN "Employee" e ON e."id" = t."employeeId"
         WHERE e."tenantId" = ANY($1::text[]) GROUP BY 1 ORDER BY 1`,
        tenantIds,
      );
      return {
        hashes,
        rowCounts,
        kinds: kinds.map((r) => `${r.k}=${Number(r.n)}`).join(","),
      };
    }

    async function catalogCounts(tx: Db) {
      const rows = await tx.$queryRawUnsafe<{ name: string; n: bigint }[]>(
        `SELECT 'column' AS name, count(*) AS n FROM information_schema.columns
           WHERE table_name = 'TimeEntry' AND column_name = 'travelToSalonId'
         UNION ALL SELECT 'check', count(*) FROM pg_constraint
           WHERE conrelid = '"TimeEntry"'::regclass AND conname = 'TimeEntry_travel_shape_check'
         UNION ALL SELECT 'fk', count(*) FROM pg_constraint
           WHERE conname = 'TimeEntry_travelToSalonId_fkey'
         UNION ALL SELECT 'index', count(*) FROM pg_indexes
           WHERE indexname = 'TimeEntry_travelToSalonId_idx'`,
      );
      return Object.fromEntries(rows.map((r) => [r.name, Number(r.n)]));
    }

    let legacyShape = false;
    let migratedShape = false;
    let before: Awaited<ReturnType<typeof capture>> | undefined;
    let after: Awaited<ReturnType<typeof capture>> | undefined;
    let destinationsAfter = -1;
    let controlSensitive = false;

    await expect(
      app.prisma.$transaction(
        async (tx) => {
          // Recreate the pre-#92 shape: the CHECK, the foreign key, the index and the column out.
          await tx.$executeRawUnsafe(
            `ALTER TABLE "TimeEntry" DROP CONSTRAINT "TimeEntry_travel_shape_check"`,
          );
          await tx.$executeRawUnsafe(
            `ALTER TABLE "TimeEntry" DROP CONSTRAINT "TimeEntry_travelToSalonId_fkey"`,
          );
          await tx.$executeRawUnsafe(`DROP INDEX "TimeEntry_travelToSalonId_idx"`);
          await tx.$executeRawUnsafe(`ALTER TABLE "TimeEntry" DROP COLUMN "travelToSalonId"`);
          const legacy = await catalogCounts(tx);
          legacyShape =
            legacy.column === 0 && legacy.check === 0 && legacy.fk === 0 && legacy.index === 0;

          before = await capture(tx);
          // The statements of the REAL files, in directory order; any row they cannot accept
          // would raise here (ADD CONSTRAINT validates every existing row).
          for (const statement of [...columnStatements, ...checkStatements]) {
            await tx.$executeRawUnsafe(statement);
          }
          after = await capture(tx);

          const migrated = await catalogCounts(tx);
          migratedShape =
            migrated.column === 1 &&
            migrated.check === 1 &&
            migrated.fk === 1 &&
            migrated.index === 1;
          const dest = await tx.$queryRawUnsafe<{ n: bigint }[]>(
            `SELECT count(*) AS n FROM "TimeEntry" t JOIN "Employee" e ON e."id" = t."employeeId"
             WHERE e."tenantId" = ANY($1::text[]) AND t."travelToSalonId" IS NOT NULL`,
            tenantIds,
          );
          destinationsAfter = Number(dest[0].n);

          // Control: the comparison is sensitive — one changed saldo input moves the hash.
          await tx.$executeRawUnsafe(
            `UPDATE "TimeEntry" SET "breakMinutes" = "breakMinutes" + 1 WHERE "id" = (
               SELECT t."id" FROM "TimeEntry" t JOIN "Employee" e ON e."id" = t."employeeId"
               WHERE e."tenantId" = ANY($1::text[]) AND t."endTime" IS NOT NULL
               ORDER BY t."id" LIMIT 1)`,
            tenantIds,
          );
          const touched = await capture(tx);
          controlSensitive =
            touched.hashes.entries !== after.hashes.entries &&
            touched.hashes.facade !== after.hashes.facade;
          throw new TravelMigrationRollback();
        },
        { timeout: 30_000 },
      ),
    ).rejects.toThrow(TravelMigrationRollback);

    expect(legacyShape, "the legacy shape was recreated before the replay").toBe(true);
    expect(before).toBeDefined();
    expect(after).toBeDefined();
    // Every saldo input and every snapshot is byte-identical across the replay.
    expect(after!.hashes).toEqual(before!.hashes);
    expect(after!.rowCounts).toEqual(before!.rowCounts);
    // The rows per activityKind are unchanged and no existing row received a destination.
    expect(after!.kinds).toBe(before!.kinds);
    expect(destinationsAfter).toBe(0);
    expect(migratedShape, "the replay produced the migrated shape").toBe(true);
    expect(controlSensitive, "a changed row moves the hash (the comparison is not vacuous)").toBe(
      true,
    );
    // Vacuity guard: every compared group really held rows.
    for (const group of ["entries", "breaks", "snapshots", "accounts", "schedules", "employees"]) {
      expect(before!.rowCounts[group], `group ${group} is non-empty`).toBeGreaterThan(0);
    }
    // 2 tenants x (2 employees x 6 entries + 1 running entry), one Break row per tenant, one
    // snapshot per employee of the first tenant.
    expect(before!.rowCounts.entries).toBe(26);
    expect(before!.rowCounts.breaks).toBe(2);
    expect(before!.rowCounts.snapshots).toBe(2);
    expect(before!.rowCounts.facade).toBe(8);

    // Rollback proof: the migrated shape is back for every other file.
    const back = await app.prisma.$queryRaw<{ n: bigint }[]>`
      SELECT count(*) AS n FROM information_schema.columns
      WHERE table_name = 'TimeEntry' AND column_name = 'travelToSalonId'`;
    expect(Number(back[0].n)).toBe(1);
  });
});

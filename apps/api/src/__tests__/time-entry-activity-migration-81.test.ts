/**
 * Issue #81 — AK-4 / D-03 / D-19 and the data-path tracer of the activity kind.
 *
 * Executes the REAL migration text (never a restatement of it): the file is resolved by the
 * hard-coded directory constant below (never a directory listing), and the replay runs inside a
 * `$transaction` that always ends by throwing a module-private sentinel, so nothing the replay does
 * lands in the shared test database. Same technique as `time-entry-salon-migration.test.ts` (Phase
 * 68b): assertions run AFTER the rejection, on values captured outside the callback (an assertion
 * failure inside the callback would be masked by the rollback).
 *
 * The migrated test database already has the three new objects, so the replay first drops them
 * INSIDE the rolled-back transaction (Postgres DDL is transactional) to recreate the legacy shape.
 * The DDL holds an ACCESS EXCLUSIVE lock on "TimeEntry" until the transaction ends — no
 * `app.inject` and no read on another connection while it is open.
 *
 * Cases: (1) the migration text is five additive statements, (2) the catalog has the column, the
 * Cascade foreign key and the unique index, (3) a raw INSERT without the column reads UNSPECIFIED,
 * (4) replaying the migration on the legacy shape leaves every saldo input and every snapshot
 * byte-identical (AK-4), (5) the tracer: a stored share reads back through the tenant-bound store
 * and `activityMinutes()`.
 *
 * Amended 2026-10-16 for #92 (Phase 92b, D-05): the full `activityMinutes()` result objects gain the
 * fourth kind TRAVEL (0 for these ordinary entries). Case count unchanged.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import type { FastifyInstance } from "fastify";
import { getTestApp, seedTestData, cleanupTestData } from "./setup";
import { activityMinutes } from "../contexts/time-tracking/activity-minutes";
import { loadActivityRowsForEntries } from "../contexts/time-tracking/activity-store";

// __dirname is apps/api/src/__tests__ — four levels up is the repo root.
const REPO_ROOT = join(__dirname, "..", "..", "..", "..");
const TIME_ENTRY_ACTIVITY_KIND_MIGRATION_DIR = "20261011150306_time_entry_activity_kind";
const MIGRATION_PATH = join(
  REPO_ROOT,
  "packages/db/prisma/migrations",
  TIME_ENTRY_ACTIVITY_KIND_MIGRATION_DIR,
  "migration.sql",
);

/** Thrown at the end of the replay transaction so the legacy-shape DDL always rolls back. */
class ActivityKindMigrationReplayRollback extends Error {}

function readMigration(): string {
  return readFileSync(MIGRATION_PATH, "utf8");
}

/** Comment-only lines removed, then split on a semicolon that ends a line (the terminator). */
function splitStatements(sql: string): string[] {
  const withoutComments = sql
    .split("\n")
    .filter((line) => !line.trim().startsWith("--"))
    .join("\n");
  return withoutComments
    .split(/;\s*\n/)
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
}

describe("migration text (AK-4, D-03, D-19)", () => {
  it("is exactly five additive statements ending in a semicolon", () => {
    const sql = readMigration();
    const terminated = sql.split("\n").filter((line) => /;\s*$/.test(line));
    expect(terminated).toHaveLength(5);
    expect(splitStatements(sql)).toHaveLength(5);
  });

  it("adds the column NOT NULL with the UNSPECIFIED default and a Cascade foreign key", () => {
    const sql = readMigration();
    expect(sql).toMatch(
      /ADD COLUMN\s+"activityKind"\s+"ActivityKind"\s+NOT NULL\s+DEFAULT\s+'UNSPECIFIED'/,
    );
    expect(sql.match(/ON DELETE CASCADE/g)).toHaveLength(1);
  });

  it("contains no UPDATE, DELETE, DROP or INSERT statement", () => {
    expect(readMigration()).not.toMatch(/^\s*(UPDATE|DELETE|DROP|INSERT)\b/im);
  });
});

describe("Issue #81 — activity kind: catalog, legacy default, replay and tracer", () => {
  let app: FastifyInstance;
  let data: Awaited<ReturnType<typeof seedTestData>>;
  let other: Awaited<ReturnType<typeof seedTestData>>;
  const ids: Record<string, string> = {};

  beforeAll(async () => {
    app = await getTestApp();
    data = await seedTestData(app, "act81mig");
    other = await seedTestData(app, "act81mig-b");

    async function entry(
      key: string,
      date: string,
      start: string,
      end: string | null,
      extra: Record<string, unknown> = {},
    ) {
      const row = await app.prisma.timeEntry.create({
        data: {
          employeeId: data.employee.id,
          salonId: data.salonId,
          date: new Date(date),
          startTime: new Date(`${date}T${start}Z`),
          endTime: end ? new Date(`${date}T${end}Z`) : null,
          source: "MANUAL",
          breakMinutes: 45,
          ...extra,
        },
      });
      ids[key] = row.id;
    }

    // Tracer entry (with a Break row), untouched legacy entry, invalid entry, soft-deleted entry.
    await entry("tracer", "2026-03-10", "08:00:00", "17:00:00");
    await app.prisma.break.create({
      data: {
        timeEntryId: ids.tracer,
        startTime: new Date("2026-03-10T12:00:00Z"),
        endTime: new Date("2026-03-10T12:45:00Z"),
      },
    });
    await entry("legacy", "2026-03-11", "08:00:00", "17:00:00");
    await entry("invalid", "2026-03-12", "08:00:00", "16:00:00", {
      isInvalid: true,
      invalidReason: "act81",
    });
    await entry("deleted", "2026-03-13", "08:00:00", "16:00:00", { deletedAt: new Date() });

    // Foreign tenant's entry for the store's tenant binding.
    const foreign = await app.prisma.timeEntry.create({
      data: {
        employeeId: other.employee.id,
        salonId: other.salonId,
        date: new Date("2026-03-10"),
        startTime: new Date("2026-03-10T08:00:00Z"),
        endTime: new Date("2026-03-10T17:00:00Z"),
        source: "MANUAL",
        breakMinutes: 45,
      },
    });
    ids.foreign = foreign.id;

    // Saldo-side rows the migration must not touch.
    await app.prisma.saldoSnapshot.create({
      data: {
        employeeId: data.employee.id,
        periodType: "MONTHLY",
        periodStart: new Date("2026-02-01"),
        periodEnd: new Date("2026-02-28"),
        workedMinutes: 9600,
        expectedMinutes: 9360,
        balanceMinutes: 240,
        carryOver: 240,
        closedAt: new Date("2026-03-01T00:00:00Z"),
      },
    });
    await app.prisma.overtimeAccount.upsert({
      where: { employeeId: data.employee.id },
      update: { balanceHours: 4 },
      create: { employeeId: data.employee.id, balanceHours: 4 },
    });
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

  it("has the column NOT NULL with the default, a Cascade foreign key and the unique index", async () => {
    const col = await app.prisma.$queryRaw<{ is_nullable: string; column_default: string }[]>`
      SELECT is_nullable, column_default FROM information_schema.columns
      WHERE table_name = 'TimeEntry' AND column_name = 'activityKind'`;
    expect(col).toHaveLength(1);
    expect(col[0].is_nullable).toBe("NO");
    expect(col[0].column_default).toContain("UNSPECIFIED");

    const fk = await app.prisma.$queryRaw<{ del: string }[]>`
      SELECT confdeltype::text AS del FROM pg_constraint
      WHERE conname = 'TimeEntryActivityShare_timeEntryId_fkey'`;
    expect(fk).toHaveLength(1);
    expect(fk[0].del).toBe("c");

    const idx = await app.prisma.$queryRaw<{ indexdef: string }[]>`
      SELECT indexdef FROM pg_indexes
      WHERE indexname = 'TimeEntryActivityShare_timeEntryId_kind_key'`;
    expect(idx).toHaveLength(1);
    expect(idx[0].indexdef).toContain("UNIQUE");
  });

  it("reads UNSPECIFIED for a raw INSERT that omits the column", async () => {
    const id = `act81-raw-${Date.now().toString(36)}`;
    await app.prisma.$executeRaw`
      INSERT INTO "TimeEntry" ("id", "employeeId", "date", "startTime", "updatedAt", "salonId")
      VALUES (${id}, ${data.employee.id}, '2026-03-16'::date, '2026-03-16T08:00:00Z'::timestamptz,
              now(), ${data.salonId})`;
    const rows = await app.prisma.$queryRaw<{ activityKind: string }[]>`
      SELECT "activityKind"::text AS "activityKind" FROM "TimeEntry" WHERE "id" = ${id}`;
    expect(rows).toEqual([{ activityKind: "UNSPECIFIED" }]);
  });

  it("replays the real migration on the legacy shape without moving any saldo input (AK-4)", async () => {
    const statements = splitStatements(readMigration());
    expect(statements).toHaveLength(5);
    const employeeId = data.employee.id;
    const tenantId = data.tenant.id;

    type Hash = {
      entries: string;
      breaks: string;
      snapshots: string;
      accounts: string;
    };
    async function hashes(tx: {
      $queryRawUnsafe: <T>(q: string, ...v: unknown[]) => Promise<T>;
    }): Promise<Hash> {
      const one = async (q: string, param: string) => {
        const r = await tx.$queryRawUnsafe<{ h: string }[]>(q, param);
        return r[0].h;
      };
      return {
        entries: await one(
          `
          SELECT md5(coalesce(string_agg(
            ("id", "employeeId", "date", "startTime", "endTime", "breakMinutes", "type", "source",
             "isInvalid", "isLocked", "deletedAt", "salonId", "breakStatus")::text,
            '|' ORDER BY "id"), '')) AS h
          FROM "TimeEntry" WHERE "employeeId" = $1`,
          employeeId,
        ),
        breaks: await one(
          `
          SELECT md5(coalesce(string_agg(
            (b."id", b."timeEntryId", b."startTime", b."endTime")::text, '|' ORDER BY b."id"), '')) AS h
          FROM "Break" b JOIN "TimeEntry" t ON t."id" = b."timeEntryId"
          WHERE t."employeeId" = $1`,
          employeeId,
        ),
        snapshots: await one(
          `
          SELECT md5(coalesce(string_agg(s::text, '|' ORDER BY s."id"), '')) AS h
          FROM "SaldoSnapshot" s JOIN "Employee" e ON e."id" = s."employeeId"
          WHERE e."tenantId" = $1`,
          tenantId,
        ),
        accounts: await one(
          `
          SELECT md5(coalesce(string_agg(a::text, '|' ORDER BY a."id"), '')) AS h
          FROM "OvertimeAccount" a JOIN "Employee" e ON e."id" = a."employeeId"
          WHERE e."tenantId" = $1`,
          tenantId,
        ),
      };
    }

    let before: Hash | undefined;
    let after: Hash | undefined;
    let fixtureRows = 0;
    let nonDefault = -1;

    await expect(
      app.prisma.$transaction(
        async (tx) => {
          await tx.$executeRawUnsafe(`DROP TABLE "TimeEntryActivityShare"`);
          await tx.$executeRawUnsafe(`ALTER TABLE "TimeEntry" DROP COLUMN "activityKind"`);
          await tx.$executeRawUnsafe(`DROP TYPE "ActivityKind"`);

          before = await hashes(tx);
          for (const statement of statements) {
            await tx.$executeRawUnsafe(statement);
          }
          after = await hashes(tx);

          const counts = await tx.$queryRawUnsafe<{ total: bigint; nondefault: bigint }[]>(
            `SELECT count(*) AS total,
                    count(*) FILTER (WHERE "activityKind" <> 'UNSPECIFIED') AS nondefault
             FROM "TimeEntry" WHERE "employeeId" = $1`,
            employeeId,
          );
          fixtureRows = Number(counts[0].total);
          nonDefault = Number(counts[0].nondefault);
          throw new ActivityKindMigrationReplayRollback();
        },
        { timeout: 30_000 },
      ),
    ).rejects.toThrow(ActivityKindMigrationReplayRollback);

    expect(before).toBeDefined();
    expect(after).toEqual(before);
    // The fixture really contains rows (an empty set would make the hash comparison vacuous).
    expect(fixtureRows).toBeGreaterThanOrEqual(4);
    expect(nonDefault).toBe(0);

    // Rollback proof: the migrated shape is back.
    const col = await app.prisma.$queryRaw<{ n: bigint }[]>`
      SELECT count(*) AS n FROM information_schema.columns
      WHERE table_name = 'TimeEntry' AND column_name = 'activityKind'`;
    const tbl = await app.prisma.$queryRaw<{ n: bigint }[]>`
      SELECT count(*) AS n FROM information_schema.tables
      WHERE table_name = 'TimeEntryActivityShare'`;
    expect(Number(col[0].n)).toBe(1);
    expect(Number(tbl[0].n)).toBe(1);
  });

  it("tracer: a stored share reads back as 435 / 60 / 0; the untouched legacy entry as 495 UNSPECIFIED", async () => {
    await app.prisma.timeEntry.update({
      where: { id: ids.tracer },
      data: {
        activityKind: "PRODUCTIVE",
        activityShares: { create: [{ kind: "SETUP_CLEANING", minutes: 60 }] },
      },
    });

    const rows = await loadActivityRowsForEntries(app.prisma, data.tenant.id, [
      ids.tracer,
      ids.legacy,
    ]);
    const tracerRow = rows.get(ids.tracer)!;
    const legacyRow = rows.get(ids.legacy)!;
    expect(tracerRow.salonId).toBe(data.salonId);

    const tracerEntry = await app.prisma.timeEntry.findUniqueOrThrow({
      where: { id: ids.tracer },
    });
    const legacyEntry = await app.prisma.timeEntry.findUniqueOrThrow({
      where: { id: ids.legacy },
    });
    expect(
      activityMinutes({ ...tracerEntry, activityKind: tracerRow.activityKind }, tracerRow.shares),
    ).toEqual({ PRODUCTIVE: 435, SETUP_CLEANING: 60, UNSPECIFIED: 0, TRAVEL: 0 });
    expect(
      activityMinutes({ ...legacyEntry, activityKind: legacyRow.activityKind }, legacyRow.shares),
    ).toEqual({ PRODUCTIVE: 0, SETUP_CLEANING: 0, UNSPECIFIED: 495, TRAVEL: 0 });
  });

  it("store: a foreign tenant's entry is absent, a soft-deleted one too, an empty list is an empty map", async () => {
    const rows = await loadActivityRowsForEntries(app.prisma, data.tenant.id, [
      ids.tracer,
      ids.foreign,
      ids.deleted,
    ]);
    expect([...rows.keys()]).toEqual([ids.tracer]);

    const empty = await loadActivityRowsForEntries(app.prisma, data.tenant.id, []);
    expect(empty.size).toBe(0);
  });
});

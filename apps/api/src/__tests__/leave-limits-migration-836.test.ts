/**
 * Issue #836 (AC-1, D-836-01) — the LeaveLimitRule table and its hand-written CHECK constraints.
 *
 * Executes the REAL migration text (never a restatement of it): both files are resolved by the
 * hard-coded directory constants below (never a directory listing), and every DDL replay or probe
 * insert runs inside a `$transaction` that always ends by throwing a module-private sentinel, so
 * nothing lands in the shared test database. Same technique as `coverage-rule-salon-migration-647`:
 * assertions run AFTER the rejection, on values captured outside the callback. A failed statement
 * aborts a transaction, so every refusal probe has a transaction of its own. The replay holds
 * ACCESS EXCLUSIVE locks while it is open: no `app.inject` and no read on another connection inside.
 *
 * Cases: (1) the generated file is the enum, the table, three indexes and three RESTRICT keys, and
 * the hand-written file is exactly the three CHECKs, (2) the catalog holds the table, the three
 * RESTRICT foreign keys and the three CHECKs, (3) a negative maxPersons, an inverted window and
 * every malformed group shape are refused with 23514 while the well-formed shapes pass (and either
 * window bound alone is fine), (4) a salon or an access role referenced by a rule — a soft-deleted
 * rule included — cannot be deleted, (5) replaying both files on a database without the table
 * rebuilds it and leaves every other table's column list unchanged.
 *
 * Mutation proof (Phase 836, 2026-11-06) — recorded here, not re-run by CI. The probe cases read
 * the live database, so the proofs mutate the four worker databases of this working directory
 * (`ALTER TABLE ... DROP/ADD CONSTRAINT`) and `test:setup` re-cloned them from the untouched
 * template afterwards:
 * M1 `LeaveLimitRule_maxPersons_check` dropped -> red: "the catalog holds the table …" and "a
 *    negative maxPersons is refused with 23514 …" (2 failed | 8 passed).
 * M2 the ACCESS_ROLE branch of `LeaveLimitRule_group_shape_check` loosened to
 *    `"accessRoleId" IS NOT NULL` (the classification no longer required to be null) -> red: "a
 *    group shape with a stray or a missing column is refused with 23514" (1 failed | 9 passed).
 * The two text cases pin the migration FILES (a statement dropped or added there is red).
 *
 * No person names in fixtures. Every fixture id is a UUID.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { inspect } from "node:util";
import { randomUUID } from "node:crypto";
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import type { FastifyInstance } from "fastify";
import { getTestApp, seedTestData, cleanupTestData, createTestSalon } from "./setup";
import { SYSTEM_ROLE_IDS } from "../contexts/platform";

// __dirname is apps/api/src/__tests__ — four levels up is the repo root.
const REPO_ROOT = join(__dirname, "..", "..", "..", "..");
const MIGRATIONS_DIR = join(REPO_ROOT, "packages/db/prisma/migrations");
const TABLE_DIR = "20261106131444_leave_limit_rule";
const CHECKS_DIR = "20261106132018_leave_limit_rule_checks";

/** Thrown at the end of a transaction so its DDL and writes always roll back. */
class LeaveLimitMigrationRollback extends Error {}

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
    .split(/;\s*\n?/)
    .map((s) => s.trim().replace(/\s+/g, " "))
    .filter((s) => s.length > 0);
}

const EXPECTED_CHECK_STATEMENTS = [
  `ALTER TABLE "LeaveLimitRule" ADD CONSTRAINT "LeaveLimitRule_maxPersons_check" CHECK ("maxPersons" >= 0)`,
  `ALTER TABLE "LeaveLimitRule" ADD CONSTRAINT "LeaveLimitRule_window_check" CHECK ("validFrom" IS NULL OR "validUntil" IS NULL OR "validFrom" <= "validUntil")`,
  `ALTER TABLE "LeaveLimitRule" ADD CONSTRAINT "LeaveLimitRule_group_shape_check" CHECK ( ("groupKind" = 'ALL' AND "classification" IS NULL AND "accessRoleId" IS NULL) OR ("groupKind" = 'CLASSIFICATION' AND "classification" IS NOT NULL AND "accessRoleId" IS NULL) OR ("groupKind" = 'ACCESS_ROLE' AND "accessRoleId" IS NOT NULL AND "classification" IS NULL) )`,
];

type Probe = {
  groupKind: "ALL" | "CLASSIFICATION" | "ACCESS_ROLE";
  classification?: string | null;
  accessRoleId?: string | null;
  maxPersons?: number;
  validFrom?: string | null;
  validUntil?: string | null;
};

describe("Issue #836 — leave limit rule migrations", () => {
  let app: FastifyInstance;
  let data: Awaited<ReturnType<typeof seedTestData>>;

  /** Insert one rule inside a rolled-back transaction; "ok" or the inspected database error. */
  async function probe(p: Probe): Promise<string> {
    let outcome = "unset";
    await expect(
      app.prisma.$transaction(async (tx) => {
        try {
          await tx.$executeRawUnsafe(
            `INSERT INTO "LeaveLimitRule"
               ("id", "tenantId", "salonId", "groupKind", "classification", "accessRoleId",
                "maxPersons", "validFrom", "validUntil", "updatedAt")
             VALUES ($1, $2, $3, $4::"LeaveLimitGroupKind", $5::"EmployeeClassification", $6,
                $7, $8::date, $9::date, now())`,
            randomUUID(),
            data.tenant.id,
            data.salonId,
            p.groupKind,
            p.classification ?? null,
            p.accessRoleId ?? null,
            p.maxPersons ?? 1,
            p.validFrom ?? null,
            p.validUntil ?? null,
          );
          outcome = "ok";
        } catch (err) {
          outcome = inspect(err, { depth: 10 });
        }
        throw new LeaveLimitMigrationRollback();
      }),
    ).rejects.toThrow(LeaveLimitMigrationRollback);
    return outcome;
  }

  beforeAll(async () => {
    app = await getTestApp();
    data = await seedTestData(app, "mig836");
  });

  afterAll(async () => {
    try {
      await cleanupTestData(app, data.tenant.id);
    } catch (err) {
      console.error("Test cleanup failed:", err);
    }
  });

  it("the generated file is the enum, the table, three indexes and three RESTRICT keys", () => {
    const statements = splitStatements(readMigration(TABLE_DIR));
    expect(statements.filter((s) => s.startsWith("CREATE TYPE")).length).toBe(1);
    expect(statements.filter((s) => s.startsWith("CREATE TABLE")).length).toBe(1);
    expect(statements.filter((s) => s.startsWith("CREATE INDEX")).length).toBe(3);
    const keys = statements.filter((s) => s.includes("FOREIGN KEY"));
    expect(keys).toHaveLength(3);
    for (const key of keys) expect(key).toContain("ON DELETE RESTRICT ON UPDATE CASCADE");
    expect(statements, "nothing beyond the 8 generated statements").toHaveLength(8);
  });

  it("the hand-written file is exactly the three CHECKs", () => {
    expect(splitStatements(readMigration(CHECKS_DIR))).toEqual(EXPECTED_CHECK_STATEMENTS);
  });

  it("the catalog holds the table, the three RESTRICT foreign keys and the three CHECKs", async () => {
    const tables = await app.prisma.$queryRaw<{ n: bigint }[]>`
      SELECT count(*) AS n FROM information_schema.tables WHERE table_name = 'LeaveLimitRule'`;
    expect(Number(tables[0].n)).toBe(1);

    const fks = await app.prisma.$queryRaw<{ name: string; del: string; target: string }[]>`
      SELECT conname AS name, confdeltype::text AS del, confrelid::regclass::text AS target
      FROM pg_constraint WHERE conrelid = '"LeaveLimitRule"'::regclass AND contype = 'f'
      ORDER BY conname`;
    expect(fks).toEqual([
      { name: "LeaveLimitRule_accessRoleId_fkey", del: "r", target: '"AccessRole"' },
      { name: "LeaveLimitRule_salonId_fkey", del: "r", target: '"Salon"' },
      { name: "LeaveLimitRule_tenantId_fkey", del: "r", target: '"Tenant"' },
    ]);

    const checks = await app.prisma.$queryRaw<{ name: string }[]>`
      SELECT conname AS name FROM pg_constraint
      WHERE conrelid = '"LeaveLimitRule"'::regclass AND contype = 'c' ORDER BY conname`;
    expect(checks.map((c) => c.name)).toEqual([
      "LeaveLimitRule_group_shape_check",
      "LeaveLimitRule_maxPersons_check",
      "LeaveLimitRule_window_check",
    ]);
  });

  it("a negative maxPersons is refused with 23514, zero (a blackout) and one pass", async () => {
    expect(await probe({ groupKind: "ALL", maxPersons: -1 })).toContain("23514");
    expect(await probe({ groupKind: "ALL", maxPersons: 0 })).toBe("ok");
    expect(await probe({ groupKind: "ALL", maxPersons: 1 })).toBe("ok");
  });

  it("an inverted window is refused with 23514, either bound alone or a one-day window passes", async () => {
    expect(
      await probe({ groupKind: "ALL", validFrom: "2027-12-31", validUntil: "2027-12-01" }),
    ).toContain("23514");
    expect(await probe({ groupKind: "ALL", validFrom: "2027-12-01", validUntil: null })).toBe("ok");
    expect(await probe({ groupKind: "ALL", validFrom: null, validUntil: "2027-12-31" })).toBe("ok");
    expect(
      await probe({ groupKind: "ALL", validFrom: "2027-12-01", validUntil: "2027-12-01" }),
    ).toBe("ok");
  });

  it("a group shape with a stray or a missing column is refused with 23514", async () => {
    const role = SYSTEM_ROLE_IDS.ADMIN;
    expect(await probe({ groupKind: "ALL", classification: "AZUBI" })).toContain("23514");
    expect(await probe({ groupKind: "ALL", accessRoleId: role })).toContain("23514");
    expect(await probe({ groupKind: "CLASSIFICATION" })).toContain("23514");
    expect(
      await probe({ groupKind: "CLASSIFICATION", classification: "AZUBI", accessRoleId: role }),
    ).toContain("23514");
    expect(await probe({ groupKind: "ACCESS_ROLE" })).toContain("23514");
    expect(
      await probe({ groupKind: "ACCESS_ROLE", accessRoleId: role, classification: "AZUBI" }),
    ).toContain("23514");
  });

  it("the three well-formed shapes pass", async () => {
    expect(await probe({ groupKind: "ALL" })).toBe("ok");
    expect(await probe({ groupKind: "CLASSIFICATION", classification: "AZUBI" })).toBe("ok");
    expect(await probe({ groupKind: "ACCESS_ROLE", accessRoleId: SYSTEM_ROLE_IDS.ADMIN })).toBe(
      "ok",
    );
  });

  it("a salon referenced by a rule cannot be deleted, a soft-deleted rule still holds it", async () => {
    let refusal = "";
    let control = -1;
    await expect(
      app.prisma.$transaction(async (tx) => {
        const salon = await createTestSalon(tx, data.tenant.id, { name: "Salon referenced" });
        await tx.leaveLimitRule.create({
          data: {
            tenantId: data.tenant.id,
            salonId: salon.id,
            groupKind: "ALL",
            maxPersons: 1,
            deletedAt: new Date(),
          },
        });
        try {
          await tx.$executeRawUnsafe(`DELETE FROM "Salon" WHERE "id" = $1`, salon.id);
        } catch (err) {
          refusal = inspect(err, { depth: 10 });
        }
        throw new LeaveLimitMigrationRollback();
      }),
    ).rejects.toThrow(LeaveLimitMigrationRollback);
    expect(refusal, "restrict_violation (23001) or foreign_key_violation (23503)").toMatch(
      /2300[1]|23503/,
    );

    // Control: an unreferenced salon of the same tenant is deletable.
    await expect(
      app.prisma.$transaction(async (tx) => {
        const salon = await createTestSalon(tx, data.tenant.id, { name: "Salon unreferenced" });
        control = await tx.$executeRawUnsafe(`DELETE FROM "Salon" WHERE "id" = $1`, salon.id);
        throw new LeaveLimitMigrationRollback();
      }),
    ).rejects.toThrow(LeaveLimitMigrationRollback);
    expect(control).toBe(1);
  });

  it("an access role referenced by a rule cannot be deleted", async () => {
    let refusal = "";
    await expect(
      app.prisma.$transaction(async (tx) => {
        const role = await tx.accessRole.create({
          data: {
            tenantId: data.tenant.id,
            name: "Rolle 836",
            nameKey: `rolle-836-${randomUUID()}`,
            permissions: [],
          },
        });
        await tx.leaveLimitRule.create({
          data: {
            tenantId: data.tenant.id,
            groupKind: "ACCESS_ROLE",
            accessRoleId: role.id,
            maxPersons: 1,
          },
        });
        try {
          await tx.$executeRawUnsafe(`DELETE FROM "AccessRole" WHERE "id" = $1`, role.id);
        } catch (err) {
          refusal = inspect(err, { depth: 10 });
        }
        throw new LeaveLimitMigrationRollback();
      }),
    ).rejects.toThrow(LeaveLimitMigrationRollback);
    expect(refusal, "restrict_violation (23001) or foreign_key_violation (23503)").toMatch(
      /23001|23503/,
    );
  });

  it("replaying both files rebuilds the table and leaves every other table's columns unchanged", async () => {
    const statements = [
      ...splitStatements(readMigration(TABLE_DIR)),
      ...splitStatements(readMigration(CHECKS_DIR)),
    ];
    type Col = Record<string, unknown>;
    const snapshot = (tx: Pick<typeof app.prisma, "$queryRawUnsafe">, own: boolean) =>
      tx.$queryRawUnsafe<Col[]>(
        `SELECT table_name, column_name, data_type, is_nullable, column_default
         FROM information_schema.columns
         WHERE table_schema = 'public' AND (table_name = 'LeaveLimitRule') = ${own}
         ORDER BY table_name, ordinal_position`,
      );
    let ownBefore: Col[] = [];
    let ownAfter: Col[] = [];
    let othersBefore: Col[] = [];
    let othersAfter: Col[] = [];
    let droppedFirst = false;

    await expect(
      app.prisma.$transaction(
        async (tx) => {
          ownBefore = await snapshot(tx, true);
          othersBefore = await snapshot(tx, false);
          await tx.$executeRawUnsafe(`DROP TABLE "LeaveLimitRule"`);
          await tx.$executeRawUnsafe(`DROP TYPE "LeaveLimitGroupKind"`);
          droppedFirst = (await snapshot(tx, true)).length === 0;
          for (const statement of statements) await tx.$executeRawUnsafe(statement);
          ownAfter = await snapshot(tx, true);
          othersAfter = await snapshot(tx, false);
          throw new LeaveLimitMigrationRollback();
        },
        { timeout: 30_000 },
      ),
    ).rejects.toThrow(LeaveLimitMigrationRollback);

    expect(droppedFirst, "the table was gone before the replay").toBe(true);
    expect(ownBefore.length, "the table has columns to compare").toBeGreaterThan(10);
    expect(ownAfter).toEqual(ownBefore);
    expect(othersBefore.length, "other tables were captured").toBeGreaterThan(100);
    expect(othersAfter).toEqual(othersBefore);

    // Rollback proof: the table is back for every other file.
    const back = await app.prisma.$queryRaw<{ n: bigint }[]>`
      SELECT count(*) AS n FROM information_schema.tables WHERE table_name = 'LeaveLimitRule'`;
    expect(Number(back[0].n)).toBe(1);
  });
});

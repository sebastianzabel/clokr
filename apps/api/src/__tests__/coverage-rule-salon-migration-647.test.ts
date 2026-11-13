/**
 * Issue #647 (AC 4, D-01) — the coverage-rule salon migration is additive, changes no existing rule
 * and its foreign key restricts.
 *
 * Executes the REAL migration text (never a restatement of it): the file is resolved by the
 * hard-coded directory constant below (never a directory listing), and every DDL replay runs inside
 * a `$transaction` that always ends by throwing a module-private sentinel, so nothing the replay
 * does lands in the shared test database. Same technique as `terminal-salon-migration-541.test.ts`
 * and the #92 travel migration test: assertions run AFTER the rejection, on values captured outside
 * the callback (an assertion failure inside the callback would be masked by the rollback). The DDL
 * holds an ACCESS EXCLUSIVE lock on "CoverageRule" while the transaction is open: no `app.inject`
 * and no read on another connection inside it.
 *
 * Cases: (1) the migration text is exactly the three additive statements, (2) the catalog holds the
 * column, the index and a RESTRICT foreign key onto "Salon", (3) existing rules read NULL after the
 * replay on the legacy shape and every other column is unchanged (no backfill, no guessed salon),
 * (4) a salon referenced by a rule cannot be deleted, with a control that an unreferenced one can.
 *
 * Mutation proof (Phase 647, 2026-11-05) — recorded here, not re-run by CI; each change was made on
 * the real migration.sql after a backup and undone by copying the backup back:
 * M1 an extra harmless statement appended (`ALTER TABLE "CoverageRule" ALTER COLUMN "salonId" DROP
 *    DEFAULT;`) → red: "the migration is exactly the three additive statements".
 * M2 a guessed backfill appended (an `UPDATE "CoverageRule"` setting "salonId" to the earliest
 *    created salon of the row's tenant) → red: "existing rules read NULL and are otherwise unchanged
 *    after the migration" (assertion "an existing rule is tenant-wide (NULL)") and "the migration is
 *    exactly the three additive statements".
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

// __dirname is apps/api/src/__tests__ — four levels up is the repo root.
const REPO_ROOT = join(__dirname, "..", "..", "..", "..");
const MIGRATIONS_DIR = join(REPO_ROOT, "packages/db/prisma/migrations");
const MIGRATION_DIR = "20261105075545_coverage_rule_salon";

/** Thrown at the end of a transaction so its DDL and writes always roll back. */
class CoverageRuleSalonMigrationRollback extends Error {}

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

const EXPECTED_STATEMENTS = [
  `ALTER TABLE "CoverageRule" ADD COLUMN "salonId" TEXT`,
  `CREATE INDEX "CoverageRule_salonId_idx" ON "CoverageRule"("salonId")`,
  `ALTER TABLE "CoverageRule" ADD CONSTRAINT "CoverageRule_salonId_fkey" FOREIGN KEY ("salonId") REFERENCES "Salon"("id") ON DELETE RESTRICT ON UPDATE CASCADE`,
];

describe("Issue #647 — coverage rule salon migration", () => {
  let app: FastifyInstance;
  let data: Awaited<ReturnType<typeof seedTestData>>;
  let templateId: string;

  beforeAll(async () => {
    app = await getTestApp();
    data = await seedTestData(app, "mig647");
    const template = await app.prisma.shiftTemplate.create({
      data: { tenantId: data.tenant.id, name: "Vorlage 647", startTime: "09:00", endTime: "15:00" },
    });
    templateId = template.id;
  });

  afterAll(async () => {
    try {
      await cleanupTestData(app, data.tenant.id);
    } catch (err) {
      console.error("Test cleanup failed:", err);
    }
  });

  it("the migration is exactly the three additive statements", () => {
    expect(splitStatements(readMigration(MIGRATION_DIR))).toEqual(EXPECTED_STATEMENTS);
  });

  it("the catalog holds the column, the index and a RESTRICT foreign key onto Salon", async () => {
    const col = await app.prisma.$queryRaw<
      { is_nullable: string; data_type: string; column_default: string | null }[]
    >`
      SELECT is_nullable, data_type, column_default FROM information_schema.columns
      WHERE table_name = 'CoverageRule' AND column_name = 'salonId'`;
    expect(col).toEqual([{ is_nullable: "YES", data_type: "text", column_default: null }]);

    const idx = await app.prisma.$queryRaw<{ n: bigint }[]>`
      SELECT count(*) AS n FROM pg_indexes
      WHERE tablename = 'CoverageRule' AND indexname = 'CoverageRule_salonId_idx'`;
    expect(Number(idx[0].n)).toBe(1);

    const fk = await app.prisma.$queryRaw<{ del: string; target: string }[]>`
      SELECT confdeltype::text AS del, confrelid::regclass::text AS target FROM pg_constraint
      WHERE conname = 'CoverageRule_salonId_fkey' AND contype = 'f'`;
    expect(fk).toEqual([{ del: "r", target: '"Salon"' }]);
  });

  it("existing rules read NULL and are otherwise unchanged after the migration", async () => {
    const statements = splitStatements(readMigration(MIGRATION_DIR));
    const tenantWideId = randomUUID();
    const templateRuleId = randomUUID();
    let legacyShape = false;
    let before: Record<string, unknown>[] = [];
    let after: Record<string, unknown>[] = [];

    const readRows = async (tx: Pick<typeof app.prisma, "$queryRawUnsafe">) =>
      (
        await tx.$queryRawUnsafe<{ r: Record<string, unknown> }[]>(
          `SELECT row_to_json(c) AS r FROM "CoverageRule" c WHERE c."id" IN ($1, $2) ORDER BY c."id"`,
          tenantWideId,
          templateRuleId,
        )
      ).map((row) => row.r);

    await expect(
      app.prisma.$transaction(
        async (tx) => {
          // Recreate the pre-#647 shape: the foreign key, the index and the column out.
          await tx.$executeRawUnsafe(
            `ALTER TABLE "CoverageRule" DROP CONSTRAINT "CoverageRule_salonId_fkey"`,
          );
          await tx.$executeRawUnsafe(`DROP INDEX "CoverageRule_salonId_idx"`);
          await tx.$executeRawUnsafe(`ALTER TABLE "CoverageRule" DROP COLUMN "salonId"`);
          const cols = await tx.$queryRawUnsafe<{ n: bigint }[]>(
            `SELECT count(*) AS n FROM information_schema.columns
             WHERE table_name = 'CoverageRule' AND column_name = 'salonId'`,
          );
          legacyShape = Number(cols[0].n) === 0;

          // Two legacy rules in the shape the pre-#647 world could hold ("updatedAt" has no
          // database default): one tenant-wide for all templates, one for a template of the tenant.
          await tx.$executeRawUnsafe(
            `INSERT INTO "CoverageRule" ("id", "tenantId", "templateId", "dayOfWeek", "minStaff",
               "requiresNonSupervised", "updatedAt")
             VALUES ($1, $2, NULL, -1, 3.5, true, now())`,
            tenantWideId,
            data.tenant.id,
          );
          await tx.$executeRawUnsafe(
            `INSERT INTO "CoverageRule" ("id", "tenantId", "templateId", "dayOfWeek", "minStaff",
               "requiresNonSupervised", "updatedAt")
             VALUES ($1, $2, $3, 4, 1, false, now())`,
            templateRuleId,
            data.tenant.id,
            templateId,
          );
          before = await readRows(tx);

          // The statements of the REAL file, in order.
          for (const statement of statements) await tx.$executeRawUnsafe(statement);

          after = await readRows(tx);
          throw new CoverageRuleSalonMigrationRollback();
        },
        { timeout: 30_000 },
      ),
    ).rejects.toThrow(CoverageRuleSalonMigrationRollback);

    expect(legacyShape, "the legacy shape was recreated before the replay").toBe(true);
    expect(before, "both legacy rules were captured").toHaveLength(2);
    expect(after, "both legacy rules survive the replay").toHaveLength(2);
    for (const row of after) {
      expect(row.salonId, "an existing rule is tenant-wide (NULL)").toBeNull();
    }
    // Every other column equals the captured value (the new key is the only difference).
    const withoutSalon = after.map((row) => {
      const copy = { ...row };
      delete copy.salonId;
      return copy;
    });
    expect(withoutSalon).toEqual(before);

    // Rollback proof: the migrated column is back for every other file and the rules are gone.
    const back = await app.prisma.$queryRaw<{ n: bigint }[]>`
      SELECT count(*) AS n FROM information_schema.columns
      WHERE table_name = 'CoverageRule' AND column_name = 'salonId'`;
    expect(Number(back[0].n)).toBe(1);
    expect(
      await app.prisma.coverageRule.count({
        where: { id: { in: [tenantWideId, templateRuleId] } },
      }),
      "the legacy rules rolled back",
    ).toBe(0);
  });

  it("a salon referenced by a rule cannot be deleted, an unreferenced one can", async () => {
    let referencedRefusal = "";
    let unreferencedRemaining = -1;
    let unreferencedDeleted = -1;

    // Refusal: a failed statement aborts the transaction, so each half has its own.
    await expect(
      app.prisma.$transaction(async (tx) => {
        const salon = await createTestSalon(tx, data.tenant.id, { name: "Salon referenced" });
        await tx.coverageRule.create({
          data: {
            tenantId: data.tenant.id,
            dayOfWeek: -1,
            minStaff: 1,
            requiresNonSupervised: false,
            salonId: salon.id,
          },
        });
        try {
          await tx.$executeRawUnsafe(`DELETE FROM "Salon" WHERE "id" = $1`, salon.id);
        } catch (err) {
          referencedRefusal = inspect(err, { depth: 10 });
        }
        throw new CoverageRuleSalonMigrationRollback();
      }),
    ).rejects.toThrow(CoverageRuleSalonMigrationRollback);
    expect(
      referencedRefusal,
      "the delete of a referenced salon is refused with SQLSTATE 23001 (restrict_violation, ON DELETE RESTRICT)",
    ).toContain("23001");

    // Control: the same delete for a salon with only a tenant-wide rule around succeeds.
    await expect(
      app.prisma.$transaction(async (tx) => {
        const salon = await createTestSalon(tx, data.tenant.id, { name: "Salon unreferenced" });
        await tx.coverageRule.create({
          data: {
            tenantId: data.tenant.id,
            dayOfWeek: -1,
            minStaff: 1,
            requiresNonSupervised: false,
          },
        });
        unreferencedDeleted = await tx.$executeRawUnsafe(
          `DELETE FROM "Salon" WHERE "id" = $1`,
          salon.id,
        );
        unreferencedRemaining = await tx.salon.count({ where: { id: salon.id } });
        throw new CoverageRuleSalonMigrationRollback();
      }),
    ).rejects.toThrow(CoverageRuleSalonMigrationRollback);
    expect(
      unreferencedDeleted,
      "the unreferenced salon was deleted (the refusal comes from the rule's key)",
    ).toBe(1);
    expect(unreferencedRemaining).toBe(0);
  });
});

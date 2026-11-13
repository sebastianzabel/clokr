/**
 * Issue #541 (Phase 541-01, D-01) — the terminal-key salon migration is additive and its foreign
 * key restricts.
 *
 * Executes the REAL migration text (never a restatement of it): the file is resolved by the
 * hard-coded directory constant below (never a directory listing), and every DDL replay runs inside
 * a `$transaction` that always ends by throwing a module-private sentinel, so nothing the replay
 * does lands in the shared test database. Same technique as `travel-migration-92.test.ts`:
 * assertions run AFTER the rejection, on values captured outside the callback (an assertion
 * failure inside the callback would be masked by the rollback). The DDL holds an ACCESS EXCLUSIVE
 * lock on "TerminalApiKey" while the transaction is open: no `app.inject` and no read on another
 * connection inside it.
 *
 * Cases: (1) the migration text is exactly the three additive statements, (2) the catalog holds the
 * column, the index and a RESTRICT foreign key onto "Salon", (3) existing rows read NULL after the
 * replay on the legacy shape (no backfill), (4) a bound salon cannot be deleted, with a control
 * that an unbound one can (so the refusal comes from the new key).
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
const MIGRATION_DIR = "20261102003032_terminal_api_key_salon";

/** Thrown at the end of a transaction so its DDL and writes always roll back. */
class TerminalSalonMigrationRollback extends Error {}

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
  `ALTER TABLE "TerminalApiKey" ADD COLUMN "salonId" TEXT`,
  `CREATE INDEX "TerminalApiKey_salonId_idx" ON "TerminalApiKey"("salonId")`,
  `ALTER TABLE "TerminalApiKey" ADD CONSTRAINT "TerminalApiKey_salonId_fkey" FOREIGN KEY ("salonId") REFERENCES "Salon"("id") ON DELETE RESTRICT ON UPDATE CASCADE`,
];

describe("Issue #541 — terminal key salon migration", () => {
  let app: FastifyInstance;
  let data: Awaited<ReturnType<typeof seedTestData>>;

  beforeAll(async () => {
    app = await getTestApp();
    data = await seedTestData(app, "mig541");
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
      WHERE table_name = 'TerminalApiKey' AND column_name = 'salonId'`;
    expect(col).toEqual([{ is_nullable: "YES", data_type: "text", column_default: null }]);

    const idx = await app.prisma.$queryRaw<{ n: bigint }[]>`
      SELECT count(*) AS n FROM pg_indexes
      WHERE tablename = 'TerminalApiKey' AND indexname = 'TerminalApiKey_salonId_idx'`;
    expect(Number(idx[0].n)).toBe(1);

    const fk = await app.prisma.$queryRaw<{ del: string; target: string }[]>`
      SELECT confdeltype::text AS del, confrelid::regclass::text AS target FROM pg_constraint
      WHERE conname = 'TerminalApiKey_salonId_fkey' AND contype = 'f'`;
    expect(fk).toEqual([{ del: "r", target: '"Salon"' }]);
  });

  it("existing rows read NULL after the migration (no backfill)", async () => {
    const statements = splitStatements(readMigration(MIGRATION_DIR));
    expect(statements).toHaveLength(3);
    const keyId = randomUUID();
    let legacyShape = false;
    let salonIdAfter: string | null | undefined;

    await expect(
      app.prisma.$transaction(
        async (tx) => {
          // Recreate the pre-#541 shape: the foreign key, the index and the column out.
          await tx.$executeRawUnsafe(
            `ALTER TABLE "TerminalApiKey" DROP CONSTRAINT "TerminalApiKey_salonId_fkey"`,
          );
          await tx.$executeRawUnsafe(`DROP INDEX "TerminalApiKey_salonId_idx"`);
          await tx.$executeRawUnsafe(`ALTER TABLE "TerminalApiKey" DROP COLUMN "salonId"`);
          const cols = await tx.$queryRawUnsafe<{ n: bigint }[]>(
            `SELECT count(*) AS n FROM information_schema.columns
             WHERE table_name = 'TerminalApiKey' AND column_name = 'salonId'`,
          );
          legacyShape = Number(cols[0].n) === 0;

          // A legacy key row, written in the shape the pre-#541 world could hold.
          await tx.$executeRawUnsafe(
            `INSERT INTO "TerminalApiKey" ("id", "tenantId", "name", "keyHash", "keyPrefix")
             VALUES ($1, $2, 'legacy terminal', $3, 'clk_legacy...')`,
            keyId,
            data.tenant.id,
            `hash-${keyId}`,
          );

          // The statements of the REAL file, in order.
          for (const statement of statements) await tx.$executeRawUnsafe(statement);

          const rows = await tx.$queryRawUnsafe<{ salonId: string | null }[]>(
            `SELECT "salonId" FROM "TerminalApiKey" WHERE "id" = $1`,
            keyId,
          );
          salonIdAfter = rows.length === 1 ? rows[0].salonId : undefined;
          throw new TerminalSalonMigrationRollback();
        },
        { timeout: 30_000 },
      ),
    ).rejects.toThrow(TerminalSalonMigrationRollback);

    expect(legacyShape, "the legacy shape was recreated before the replay").toBe(true);
    expect(salonIdAfter, "the legacy row exists and reads NULL").toBeNull();

    // Rollback proof: the migrated shape is back for every other file.
    const back = await app.prisma.$queryRaw<{ n: bigint }[]>`
      SELECT count(*) AS n FROM information_schema.columns
      WHERE table_name = 'TerminalApiKey' AND column_name = 'salonId'`;
    expect(Number(back[0].n)).toBe(1);
    expect(
      await app.prisma.terminalApiKey.count({ where: { id: keyId } }),
      "the legacy row rolled back",
    ).toBe(0);
  });

  it("a bound salon cannot be deleted, an unbound one can", async () => {
    let boundRefusal = "";
    let unboundRemaining = -1;
    let unboundDeleted = -1;

    // Refusal: a failed statement aborts the transaction, so each half has its own.
    await expect(
      app.prisma.$transaction(async (tx) => {
        const salon = await createTestSalon(tx, data.tenant.id, { name: "Salon bound" });
        await tx.terminalApiKey.create({
          data: {
            tenantId: data.tenant.id,
            name: "541 bound terminal",
            keyHash: `hash-${randomUUID()}`,
            keyPrefix: "clk_bound...",
            salonId: salon.id,
          },
        });
        try {
          await tx.$executeRawUnsafe(`DELETE FROM "Salon" WHERE "id" = $1`, salon.id);
        } catch (err) {
          boundRefusal = inspect(err, { depth: 10 });
        }
        throw new TerminalSalonMigrationRollback();
      }),
    ).rejects.toThrow(TerminalSalonMigrationRollback);
    expect(
      boundRefusal,
      "the delete of a bound salon is refused with SQLSTATE 23001 (restrict_violation, ON DELETE RESTRICT)",
    ).toContain("23001");

    // Control: the same delete for a salon with only an UNBOUND key succeeds.
    await expect(
      app.prisma.$transaction(async (tx) => {
        const salon = await createTestSalon(tx, data.tenant.id, { name: "Salon unbound" });
        await tx.terminalApiKey.create({
          data: {
            tenantId: data.tenant.id,
            name: "541 unbound terminal",
            keyHash: `hash-${randomUUID()}`,
            keyPrefix: "clk_unbound...",
          },
        });
        unboundDeleted = await tx.$executeRawUnsafe(
          `DELETE FROM "Salon" WHERE "id" = $1`,
          salon.id,
        );
        unboundRemaining = await tx.salon.count({ where: { id: salon.id } });
        throw new TerminalSalonMigrationRollback();
      }),
    ).rejects.toThrow(TerminalSalonMigrationRollback);
    expect(unboundDeleted, "the unbound salon was deleted (the refusal comes from the key)").toBe(
      1,
    );
    expect(unboundRemaining).toBe(0);
  });
});

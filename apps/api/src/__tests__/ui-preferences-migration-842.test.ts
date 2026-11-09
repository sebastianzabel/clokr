/**
 * Issue #842 (D-842-17 / D-842-19) — the data-only migration that moves stored UI preferences to
 * the three-theme set (nacht/schiefer -> salz, wald -> petrol) and drops the retired skin and
 * density keys, proven on REAL SQL execution of the checked-in file (never a restatement of it).
 *
 * - Static shape: one `UPDATE "User"`, no DDL keyword outside comments, no AuditLog write.
 * - Replay: inside a transaction that is ALWAYS rolled back, the rows below are written, the file
 *   is executed, the results asserted, then executed a second time and nothing may change.
 * - Parity: the theme the SQL writes equals `normalizeUiTheme()` of the code for every retired id.
 */
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import type { FastifyInstance } from "fastify";
import { getTestApp, closeTestApp, seedTestData, cleanupTestData } from "./setup";
import { MIGRATIONS_ROOT, withRolledBackTransaction } from "./template-grant-chain";
import { LEGACY_UI_THEME_IDS, normalizeUiTheme } from "../contexts/platform/ui-theme";

const DIR_SUFFIX = "_ui_preferences_v2_themes";

function locateMigrationDir(): string {
  const entries = readdirSync(MIGRATIONS_ROOT);
  // Non-empty proof: an emptied or moved migrations directory must fail, never pass vacuously.
  expect(entries.length).toBeGreaterThan(0);
  const matches = entries.filter((name) => name.endsWith(DIR_SUFFIX));
  expect(matches).toHaveLength(1);
  return matches[0]!;
}

function readMigrationSql(): string {
  return readFileSync(join(MIGRATIONS_ROOT, locateMigrationDir(), "migration.sql"), "utf8");
}

/** The SQL without `--` comment lines, so keyword checks look at statements only. */
function statementsOnly(sql: string): string {
  return sql
    .split("\n")
    .filter((line) => !line.trimStart().startsWith("--"))
    .join("\n");
}

describe("ui preferences migration (#842, static shape)", () => {
  it("is a single UPDATE on User with no DDL and no audit write", () => {
    const body = statementsOnly(readMigrationSql());
    expect(body.match(/\bUPDATE\b/g)).toHaveLength(1);
    expect(body).toContain('UPDATE "User"');
    expect(body).toContain("jsonb_typeof");
    expect(body).not.toMatch(/\b(CREATE|ALTER|DROP|TRUNCATE|INSERT|DELETE)\b/i);
    expect(body).not.toContain("AuditLog");
    expect(body).not.toContain('"updatedAt"');
  });
});

describe("ui preferences migration (#842, replay)", () => {
  let app: FastifyInstance;
  let data: Awaited<ReturnType<typeof seedTestData>>;

  beforeAll(async () => {
    app = await getTestApp();
    data = await seedTestData(app, "uipm");
  });

  afterAll(async () => {
    try {
      await cleanupTestData(app, data.tenant.id);
    } catch (err) {
      console.error("Test cleanup failed:", err);
    }
    await closeTestApp();
  });

  type Case = { key: string; before: unknown; after: unknown };

  const CASES: Case[] = [
    {
      key: "nacht+skin+density",
      before: { theme: "nacht", skin: "modern", density: "compact" },
      after: { theme: "salz" },
    },
    { key: "schiefer", before: { theme: "schiefer" }, after: { theme: "salz" } },
    {
      key: "wald+mode",
      before: { theme: "wald", mode: "dark" },
      after: { theme: "petrol", mode: "dark" },
    },
    {
      key: "pflaume+skin",
      before: { theme: "pflaume", skin: "editorial" },
      after: { theme: "pflaume" },
    },
    {
      key: "density only keeps language",
      before: { density: "compact", language: "en" },
      after: { language: "en" },
    },
    // Untouched rows: no key of the predicate present.
    {
      key: "no relevant key",
      before: { mode: "dark", language: "en" },
      after: { mode: "dark", language: "en" },
    },
    {
      key: "already migrated",
      before: { theme: "petrol", mode: "light" },
      after: { theme: "petrol", mode: "light" },
    },
    { key: "unknown theme", before: { theme: "lila" }, after: { theme: "lila" } },
    { key: "json array", before: ["nacht", "skin"], after: ["nacht", "skin"] },
    { key: "json scalar string", before: "wald", after: "wald" },
  ];

  it("rewrites the matching rows, skips the others and is a no-op on replay", async () => {
    const sql = readMigrationSql();

    await withRolledBackTransaction(app.prisma, async (tx) => {
      const ids: Record<string, string> = {};
      for (const c of CASES) {
        const user = await tx.user.create({
          data: {
            email: `uipm-${c.key.replace(/[^a-z]/gi, "")}-${Date.now()}@test.de`,
            passwordHash: "x",
          },
        });
        ids[c.key] = user.id;
        await tx.$executeRaw`
          UPDATE "User" SET "uiPreferences" = ${JSON.stringify(c.before)}::jsonb WHERE "id" = ${user.id}
        `;
      }
      // DB NULL row (a column value, not a JSON null).
      const nullUser = await tx.user.create({
        data: { email: `uipm-dbnull-${Date.now()}@test.de`, passwordHash: "x" },
      });
      await tx.$executeRaw`UPDATE "User" SET "uiPreferences" = NULL WHERE "id" = ${nullUser.id}`;
      // JSON null row.
      const jsonNullUser = await tx.user.create({
        data: { email: `uipm-jsonnull-${Date.now()}@test.de`, passwordHash: "x" },
      });
      await tx.$executeRaw`UPDATE "User" SET "uiPreferences" = 'null'::jsonb WHERE "id" = ${jsonNullUser.id}`;

      const allIds = [...Object.values(ids), nullUser.id, jsonNullUser.id];
      const snapshot = async () =>
        tx.$queryRaw<{ id: string; prefs: unknown; isNull: boolean; updatedAt: Date }[]>`
          SELECT "id", "uiPreferences" AS prefs, ("uiPreferences" IS NULL) AS "isNull", "updatedAt"
          FROM "User" WHERE "id" = ANY(${allIds}::text[]) ORDER BY "id"
        `;
      const byId = (rows: Awaited<ReturnType<typeof snapshot>>) =>
        Object.fromEntries(rows.map((r) => [r.id, r]));

      const before = byId(await snapshot());
      await tx.$executeRawUnsafe(sql);
      const first = await snapshot();
      const firstById = byId(first);

      for (const c of CASES) {
        expect(firstById[ids[c.key]!]!.prefs, c.key).toEqual(c.after);
        // The migration never touches updatedAt.
        expect(firstById[ids[c.key]!]!.updatedAt, c.key).toEqual(before[ids[c.key]!]!.updatedAt);
      }
      expect(firstById[nullUser.id]!.isNull).toBe(true);
      expect(firstById[jsonNullUser.id]!.prefs).toBeNull();
      expect(firstById[jsonNullUser.id]!.isNull).toBe(false);

      // Replay: nothing may change any more.
      const affected = await tx.$executeRawUnsafe(sql);
      expect(await snapshot()).toEqual(first);
      expect(affected).toBeGreaterThanOrEqual(0);
    });
  });

  it("writes for every retired theme id exactly what normalizeUiTheme returns", async () => {
    const sql = readMigrationSql();
    await withRolledBackTransaction(app.prisma, async (tx) => {
      expect(LEGACY_UI_THEME_IDS.length).toBeGreaterThan(0);
      const idByTheme: Record<string, string> = {};
      for (const theme of LEGACY_UI_THEME_IDS) {
        const user = await tx.user.create({
          data: { email: `uipm-parity-${theme}-${Date.now()}@test.de`, passwordHash: "x" },
        });
        idByTheme[theme] = user.id;
        await tx.$executeRaw`
          UPDATE "User" SET "uiPreferences" = ${JSON.stringify({ theme })}::jsonb WHERE "id" = ${user.id}
        `;
      }
      await tx.$executeRawUnsafe(sql);
      for (const theme of LEGACY_UI_THEME_IDS) {
        const rows = await tx.$queryRaw<{ prefs: { theme: string } }[]>`
          SELECT "uiPreferences" AS prefs FROM "User" WHERE "id" = ${idByTheme[theme]!}
        `;
        expect(rows[0]!.prefs.theme, theme).toBe(normalizeUiTheme(theme));
      }
    });
  });
});

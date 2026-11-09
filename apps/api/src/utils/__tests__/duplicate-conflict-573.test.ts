/**
 * Issue #573 (D-08…D-10) — every unique index has its 409 text; the lookup reads structured
 * metadata only and never echoes a value.
 */
import { readFileSync, readdirSync } from "node:fs";
import { join, resolve } from "node:path";
import { describe, it, expect } from "vitest";
import {
  DUPLICATE_MESSAGES,
  GENERIC_DUPLICATE,
  duplicateConflictMessage,
  isWriteConflict,
} from "../duplicate-conflict";

const DB = resolve(__dirname, "../../../../../packages/db/prisma");

/**
 * The unique indexes the database really has: every `CREATE UNIQUE INDEX` of the migrations (Prisma
 * writes `@unique`/`@@unique` that way too, under the name Postgres keeps, at most 63 characters),
 * minus every index a later migration dropped. Comments are stripped first.
 */
function migrationUniqueIndexNames(): string[] {
  const dir = join(DB, "migrations");
  const live = new Set<string>();
  for (const entry of readdirSync(dir).sort()) {
    let sql: string;
    try {
      sql = readFileSync(join(dir, entry, "migration.sql"), "utf8");
    } catch {
      continue;
    }
    sql = sql.replace(/--[^\n]*/g, "");
    for (const m of sql.matchAll(/CREATE UNIQUE INDEX (?:IF NOT EXISTS )?"(\w+)"/g)) live.add(m[1]);
    for (const m of sql.matchAll(/ADD CONSTRAINT "(\w+)" UNIQUE/g)) live.add(m[1]);
    for (const m of sql.matchAll(/ALTER INDEX "(\w+)" RENAME TO "(\w+)"/g)) {
      if (live.delete(m[1])) live.add(m[2]);
    }
    for (const m of sql.matchAll(/DROP INDEX (?:IF EXISTS )?([^;]+)/g)) {
      for (const name of m[1].matchAll(/"(\w+)"/g)) live.delete(name[1]);
    }
  }
  return [...live];
}

function p2002(index: string, extra: Record<string, unknown> = {}) {
  return {
    code: "P2002",
    message: `Invalid invocation: email "someone@example.com" name "Hochzeit"`,
    meta: {
      driverAdapterError: {
        cause: {
          constraint: { index },
          originalMessage: `duplicate key value violates unique constraint "${index}"`,
        },
      },
      ...extra,
    },
  };
}

describe("duplicate conflict table (Issue #573)", () => {
  it("names exactly the unique indexes the database has (no missing, no stale entry)", () => {
    const live = migrationUniqueIndexNames();
    // Anti-vacuity: the walk found indexes we know exist, and a dropped one is gone.
    expect(live).toContain("SpecialLeaveRule_tenantId_name_key");
    expect(live).toContain("TimeEntry_employeeId_date_open_unique");
    expect(live).not.toContain("PublicHoliday_tenantId_date_key");
    expect(live.length).toBeGreaterThan(30);
    const keys = Object.keys(DUPLICATE_MESSAGES);
    expect(
      live.filter((n) => !keys.includes(n)),
      "unique indexes without a 409 text in DUPLICATE_MESSAGES",
    ).toEqual([]);
    expect(
      keys.filter((k) => !live.includes(k)),
      "DUPLICATE_MESSAGES entries no live index has",
    ).toEqual([]);
    // Postgres keeps at most 63 characters of an identifier; a longer key could never match.
    expect(keys.filter((k) => k.length > 63)).toEqual([]);
  });

  it("a duplicate special-leave occasion reads 'Diesen Anlass gibt es bereits.'", () => {
    expect(duplicateConflictMessage(p2002("SpecialLeaveRule_tenantId_name_key"))).toBe(
      "Diesen Anlass gibt es bereits.",
    );
  });

  it("never echoes a value and falls back to the generic text", () => {
    const text = duplicateConflictMessage(p2002("User_email_key"));
    expect(text).not.toContain("@");
    expect(duplicateConflictMessage(p2002("RefreshToken_token_key"))).toBe(GENERIC_DUPLICATE);
    expect(duplicateConflictMessage({ code: "P2002", meta: {} })).toBe(GENERIC_DUPLICATE);
  });

  it("a longer index name wins over a shorter one it contains", () => {
    expect(
      duplicateConflictMessage(p2002("SalonCoupling_tenantId_provider_externalBranchId_key")),
    ).toBe("Diese Filiale ist bereits gekoppelt.");
  });

  it("is null for anything that is no P2002; P2034 is a write conflict", () => {
    expect(duplicateConflictMessage(new Error("x"))).toBeNull();
    expect(duplicateConflictMessage({ code: "P2003" })).toBeNull();
    expect(isWriteConflict({ code: "P2034" })).toBe(true);
    expect(isWriteConflict({ code: "P2002" })).toBe(false);
  });
});

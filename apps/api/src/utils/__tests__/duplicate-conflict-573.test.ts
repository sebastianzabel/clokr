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

/** Index names Prisma derives from `@unique` / `@@unique` (default `<Model>_<fields>_key`, or `map:`). */
function schemaUniqueIndexNames(): string[] {
  const schema = readFileSync(join(DB, "schema.prisma"), "utf8");
  const names: string[] = [];
  for (const m of schema.matchAll(/^model (\w+) \{([\s\S]*?)^\}/gm)) {
    const [, model, body] = m;
    for (const raw of body.split("\n")) {
      const line = raw.split("//")[0];
      const compound = /@@unique\(\[([^\]]*)\](?:,\s*map:\s*"([^"]+)")?/.exec(line);
      if (compound) {
        const fields = compound[1].split(",").map((f) => f.trim().split("(")[0]);
        names.push(compound[2] ?? `${model}_${fields.join("_")}_key`);
        continue;
      }
      const field = /^\s+(\w+)\s+\S+.*@unique(?:\(map:\s*"([^"]+)"\))?/.exec(line);
      if (field) names.push(field[2] ?? `${model}_${field[1]}_key`);
    }
  }
  return names;
}

/** Hand-written partial unique indexes (`*_unique`) created by a migration and not dropped since. */
function handWrittenUniqueIndexNames(): string[] {
  const dir = join(DB, "migrations");
  const created = new Set<string>();
  for (const entry of readdirSync(dir).sort()) {
    let sql: string;
    try {
      sql = readFileSync(join(dir, entry, "migration.sql"), "utf8");
    } catch {
      continue;
    }
    for (const m of sql.matchAll(/CREATE UNIQUE INDEX (?:IF NOT EXISTS )?"(\w+_unique)"/g)) {
      created.add(m[1]);
    }
    for (const m of sql.matchAll(/DROP INDEX (?:IF EXISTS )?"?(\w+_unique)"?/g))
      created.delete(m[1]);
  }
  return [...created];
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
  it("names every unique index of schema.prisma and every hand-written one", () => {
    const schemaNames = schemaUniqueIndexNames();
    const handWritten = handWrittenUniqueIndexNames();
    // Anti-vacuity: the walk found the indexes we know exist.
    expect(schemaNames).toContain("SpecialLeaveRule_tenantId_name_key");
    expect(schemaNames.length).toBeGreaterThan(30);
    expect(handWritten).toContain("TimeEntry_employeeId_date_open_unique");
    const missing = [...schemaNames, ...handWritten].filter((n) => !(n in DUPLICATE_MESSAGES));
    expect(missing, "unique indexes without a 409 text in DUPLICATE_MESSAGES").toEqual([]);
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

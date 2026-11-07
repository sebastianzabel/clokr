/**
 * Issue #835 - the ordered chain of data-only template-grant migrations, for the tests that pin them.
 *
 * Why it exists: a template-grant migration (`UPDATE "AccessRole" SET "permissions" = ARRAY[...]`)
 * carries the COMPLETE template as of its own day. A test that pins such a migration against the
 * LIVE `SYSTEM_ROLE_PERMISSIONS` constant is right on the day the migration ships and wrong the day
 * the next grant ships: the older file's array no longer equals the constant, and replaying the
 * older file against the shared worker database would revert the global rows to the old template
 * (the later migration is not part of that replay).
 *
 * Two things are therefore derived here instead of restated in every pin:
 *   - `templateAsOf(slot, dirSuffix)`: the live constant minus the keys that LATER grants of the
 *     chain added to that slot, i.e. the template the named migration was written against;
 *   - `replayChainFrom(tx, dirSuffix)`: that migration and every later one, executed in order, so
 *     the end state of a replay equals the live constants again.
 * A replay never runs outside `withRolledBackTransaction`, so the rows of the shared worker
 * database are never touched.
 *
 * A future template grant adds ONE entry to `TEMPLATE_GRANT_CHAIN` (oldest first); nothing else
 * moves. A grant that changes a template in any other way than adding a key is not expressible here
 * and needs its own pin.
 */
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import type { PrismaClient } from "@clokr/db";
import { SYSTEM_ROLE_PERMISSIONS, type SystemRoleSlot } from "../contexts/platform";

// __dirname is apps/api/src/__tests__ - four levels up is the repo root.
const REPO_ROOT = join(__dirname, "..", "..", "..", "..");
export const MIGRATIONS_ROOT = join(REPO_ROOT, "packages", "db", "prisma", "migrations");

export interface TemplateGrant {
  /** The migration directory name ends with this (the timestamp prefix is not stated twice). */
  dirSuffix: string;
  /** The key the migration adds to every listed slot. */
  key: string;
  slots: readonly SystemRoleSlot[];
}

/** Oldest first. Each entry is the order the migrations run in. */
export const TEMPLATE_GRANT_CHAIN: readonly TemplateGrant[] = [
  {
    dirSuffix: "_leave_limit_template_grant",
    key: "leave-limit:manage:ZUGEWIESEN",
    slots: ["ADMIN", "OWNER", "SALON_MANAGER"],
  },
  {
    dirSuffix: "_leave_plan_template_grant",
    key: "leave-plan:manage:ZUGEWIESEN",
    slots: ["ADMIN", "OWNER", "SALON_MANAGER"],
  },
];

function indexOfGrant(dirSuffix: string): number {
  const index = TEMPLATE_GRANT_CHAIN.findIndex((g) => g.dirSuffix === dirSuffix);
  if (index < 0) throw new Error(`template-grant-chain: no chain entry "${dirSuffix}"`);
  return index;
}

/** Locates a migration directory by name suffix; zero or several matches throw (input proof). */
export function locateGrantDir(dirSuffix: string): string {
  const entries = readdirSync(MIGRATIONS_ROOT);
  if (entries.length === 0) {
    throw new Error(`template-grant-chain: ${MIGRATIONS_ROOT} lists no entries at all`);
  }
  const matches = entries.filter((name) => name.endsWith(dirSuffix));
  if (matches.length !== 1) {
    throw new Error(
      `template-grant-chain: expected exactly one directory ending in "${dirSuffix}" under ` +
        `${MIGRATIONS_ROOT}, found ${matches.length}: ${JSON.stringify(matches)}`,
    );
  }
  return matches[0]!;
}

/** The SQL text of one chain migration (read from the checked-in file, never restated). */
export function grantMigrationSql(dirSuffix: string): string {
  indexOfGrant(dirSuffix);
  return readFileSync(join(MIGRATIONS_ROOT, locateGrantDir(dirSuffix), "migration.sql"), "utf8");
}

/**
 * The template of `slot` as the migration `dirSuffix` wrote it: the live constant without the keys
 * that every LATER grant of the chain added to that slot. Catalog order is kept.
 */
export function templateAsOf(slot: SystemRoleSlot, dirSuffix: string): string[] {
  const later = TEMPLATE_GRANT_CHAIN.slice(indexOfGrant(dirSuffix) + 1)
    .filter((g) => g.slots.includes(slot))
    .map((g) => g.key);
  return SYSTEM_ROLE_PERMISSIONS[slot].filter((key) => !later.includes(key));
}

type Tx = Parameters<Parameters<PrismaClient["$transaction"]>[0]>[0];

/** Executes the migration `dirSuffix` and every later one of the chain, in order. */
export async function replayChainFrom(tx: Tx, dirSuffix: string): Promise<void> {
  for (const grant of TEMPLATE_GRANT_CHAIN.slice(indexOfGrant(dirSuffix))) {
    await tx.$executeRawUnsafe(grantMigrationSql(grant.dirSuffix));
  }
}

class RollbackSentinel extends Error {
  constructor() {
    super("template-grant-chain: intentional rollback");
  }
}

/**
 * Runs `work` inside a transaction that is ALWAYS rolled back and returns what `work` returned, so
 * a replay is observable inside and leaves nothing behind. Any other error propagates unchanged.
 */
export async function withRolledBackTransaction<T>(
  prisma: PrismaClient,
  work: (tx: Tx) => Promise<T>,
): Promise<T> {
  let result: { value: T } | undefined;
  try {
    await prisma.$transaction(async (tx) => {
      result = { value: await work(tx) };
      throw new RollbackSentinel();
    });
  } catch (error) {
    if (!(error instanceof RollbackSentinel)) throw error;
  }
  if (!result) throw new Error("template-grant-chain: the transaction body did not run");
  return result.value;
}

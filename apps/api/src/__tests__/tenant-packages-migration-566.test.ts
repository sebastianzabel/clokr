/**
 * Phase 566 (issue #566), plan 04 — AC-566-04 / D-09: the Bestandsschutz of the packages migration.
 *
 * Executes the REAL data section of the `*_tenant_packages` migration (never a restatement of it),
 * the same pattern as `salon-coupling-migration.test.ts`: every fixture lives inside ONE
 * `$transaction` that always ends by throwing a module-private sentinel, so nothing lands in the
 * shared test database. Assertions run AFTER the rejection, on values captured inside the callback
 * (an assertion failing inside it would be masked by the rollback).
 *
 * One fixture tenant per signal of D-09, plus the negatives, a deactivated tenant, a tenant without
 * any active salon and two tenants an operator already edited (catalogue:
 * `tenant-packages-migration-566-fixtures.ts`). Parity with the read-only dry run:
 * `scripts/__tests__/audit-566-package-backfill.test.ts`.
 */
import { describe, it, expect, beforeAll } from "vitest";
import type { FastifyInstance } from "fastify";
import { getTestApp } from "./setup";
import {
  FIXTURES,
  PackagesMigrationReplayRollback,
  buildFixtureTenant,
  readDataSection,
  readPackages,
  splitDataSectionStatements,
} from "./tenant-packages-migration-566-fixtures";

describe("data section shape (D-09)", () => {
  it("holds exactly one UPDATE of Tenant and no DDL or other write", () => {
    const statements = splitDataSectionStatements(readDataSection());
    expect(statements).toHaveLength(1);
    expect(statements[0].startsWith('UPDATE "Tenant"')).toBe(true);
    expect(statements[0]).not.toMatch(/\b(CREATE|ALTER|DROP|INSERT|DELETE|TRUNCATE)\b/i);
  });
});

describe("Phase 566 — the Bestandsschutz backfill replayed on per-signal fixtures (D-09, AC-566-04)", () => {
  let app: FastifyInstance;

  beforeAll(async () => {
    app = await getTestApp();
  });

  it("grants exactly what each tenant uses, keeps operator-edited tenants and is idempotent", async () => {
    const statements = splitDataSectionStatements(readDataSection());
    expect(statements).toHaveLength(1);

    type Captured = {
      ids: Record<string, string>;
      before: Record<string, { modules: string[]; quota: number }>;
      afterFirst: Record<string, { modules: string[]; quota: number }>;
      afterSecond: Record<string, { modules: string[]; quota: number }>;
    };
    let captured: Captured | undefined;

    await expect(
      app.prisma.$transaction(
        async (tx) => {
          const ids: Record<string, string> = {};
          for (const spec of FIXTURES) ids[spec.tag] = await buildFixtureTenant(tx, spec);
          const allIds = Object.values(ids);

          const before = await readPackages(tx, allIds);
          await tx.$executeRawUnsafe(statements[0]);
          const afterFirst = await readPackages(tx, allIds);
          // A second execution must change nothing: every granted or edited tenant is guarded.
          await tx.$executeRawUnsafe(statements[0]);
          const afterSecond = await readPackages(tx, allIds);

          captured = { ids, before, afterFirst, afterSecond };
          throw new PackagesMigrationReplayRollback(
            "deliberate rollback — these fixtures must never be committed",
          );
        },
        { timeout: 60000, maxWait: 30000 },
      ),
    ).rejects.toBeInstanceOf(PackagesMigrationReplayRollback);

    expect(captured, "the callback must have run to its end").toBeDefined();
    const { ids, before, afterFirst, afterSecond } = captured as Captured;

    for (const spec of FIXTURES) {
      const id = ids[spec.tag];
      const stored = spec.stored ?? { modules: [], quota: 1 };
      expect(before[id], `${spec.tag}: stored state before the section`).toEqual(stored);
      expect(afterFirst[id], `${spec.tag}: state after the first execution`).toEqual(spec.expected);
      expect(afterSecond[id], `${spec.tag}: state after the second execution`).toEqual(
        spec.expected,
      );
    }

    // The operator-edited tenants are asserted unchanged on their own, not only through the table.
    expect(afterFirst[ids.OPERATOR_EDITED_A]).toEqual(before[ids.OPERATOR_EDITED_A]);
    expect(afterFirst[ids.OPERATOR_EDITED_B]).toEqual(before[ids.OPERATOR_EDITED_B]);

    // Anti-vacuity: the catalogue produced a spread of grants, not 24 identical rows.
    const grantedKinds = new Set(Object.values(afterFirst).map((p) => p.modules.join(",")));
    expect(grantedKinds.size).toBeGreaterThanOrEqual(6);
  });
});

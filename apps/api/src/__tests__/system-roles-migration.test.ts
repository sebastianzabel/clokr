/**
 * Phase 75b (Issue #75) — the system roles: the global `AccessRole` rows in the migrated worker
 * database equal the code constant `SYSTEM_ROLE_PERMISSIONS` (D-04 drift).
 *
 * Since Phase 76b (Issue #76) this covers all SEVEN global rows (the three 75b system roles plus
 * the four 76b templates): the 76b migration also runs during `test:setup`'s `migrate deploy`, so
 * this test would silently start seeing seven rows the moment that migration merged, whether or
 * not it was updated — it is generalized over `Object.keys(SYSTEM_ROLE_IDS)` for exactly that
 * reason (RESEARCH Pitfall 5).
 *
 * Release B (#641) dropped the `User.role` column, so the former cases that executed the 75b
 * legacy-role data migration against fixture users (eligibility, idempotency, NOTICE counts) are
 * gone with it: that SQL reads the dropped column and would fail at runtime. The migration file
 * stays in the history unchanged (every stage applied it); its behaviour is recorded in
 * `docs/adr/0001-abweichungen.md` Eintrag N.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import type { FastifyInstance } from "fastify";
import { getTestApp, closeTestApp } from "./setup";
import {
  SYSTEM_ROLE_IDS,
  SYSTEM_ROLE_NAMES,
  SYSTEM_ROLE_PERMISSIONS,
  roleNameKey,
  type SystemRoleSlot,
} from "../contexts/platform";

describe("Phase 75b — system roles (Issue #75)", () => {
  let app: FastifyInstance;

  beforeAll(async () => {
    app = await getTestApp();
  });

  afterAll(async () => {
    await closeTestApp();
  });

  it("(a) D-04 drift: all seven global rows equal SYSTEM_ROLE_PERMISSIONS", async () => {
    const rows = await app.prisma.accessRole.findMany({
      where: { id: { in: Object.values(SYSTEM_ROLE_IDS) } },
      orderBy: { id: "asc" },
    });
    expect(rows).toHaveLength(7);
    // Ids a001..a007 sort lexically in slot-declaration order (confirmed, RESEARCH Pitfall 5) —
    // generalized over every slot so a merged 76b migration is covered without a hand-written
    // tuple that would otherwise silently start comparing the wrong row to the wrong slot.
    const slots = Object.keys(SYSTEM_ROLE_IDS) as SystemRoleSlot[];
    const bySlot = slots.map((slot, i) => [slot, rows[i]] as const);
    for (const [slot, row] of bySlot) {
      expect(row.id).toBe(SYSTEM_ROLE_IDS[slot]);
      expect(row.tenantId).toBeNull();
      expect(row.name).toBe(SYSTEM_ROLE_NAMES[slot]);
      expect(row.nameKey).toBe(roleNameKey(SYSTEM_ROLE_NAMES[slot]));
      expect(row.permissions).toEqual([...SYSTEM_ROLE_PERMISSIONS[slot]]);
    }
  });
});

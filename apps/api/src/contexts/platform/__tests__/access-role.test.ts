/**
 * Phase 73b Plan 02 (Issue #73) — pure unit tests for `access-role.ts`'s helpers.
 *
 * DB-free: no Prisma client, no app build, no fixture teardown. Style follows
 * `permission-catalog.test.ts` (Phase 72b) — plain `describe`/`it` over pure functions and the
 * `contexts/platform/index.ts` export-surface identity check.
 *
 * The central proof here is AK-73-7/D-11: `roleGrants` is the ONE code path #74 will evaluate a
 * role through, and it must answer identically for a system role and an unchanged copy of it that
 * carries a tenant — because it never reads `tenantId` at all. The test below is non-vacuous: it
 * asserts equality for every key of the catalog, and separately asserts that at least one of those
 * per-key results is `true` and at least one is `false`, so a `roleGrants` stub that always
 * returns the same constant for every key could never pass silently.
 */
import { describe, it, expect } from "vitest";
import { PERMISSIONS, permissionKey } from "../permission-catalog";
import {
  roleNameKey,
  unknownPermissionKeys,
  normalizeRolePermissions,
  roleGrants,
  copyRoleName,
  ROLE_NAME_MAX_LENGTH,
} from "../access-role";
import * as platform from "..";

describe("Phase 73b — access-role.ts pure helpers (Issue #73)", () => {
  describe("roleNameKey", () => {
    it("trims surrounding whitespace and lower-cases the name", () => {
      expect(roleNameKey("  Manager  ")).toBe("manager");
    });

    it("lower-cases an upper-case umlaut", () => {
      expect(roleNameKey("ÜBERSETZUNG")).toBe("übersetzung");
    });
  });

  describe("unknownPermissionKeys", () => {
    const keyA = permissionKey(PERMISSIONS[0]);
    const keyB = permissionKey(PERMISSIONS[1]);

    it("returns an empty list when every key is a catalog key", () => {
      expect(unknownPermissionKeys([keyA, keyB])).toEqual([]);
    });

    it("reports a repeated unknown key once, and keeps input order for multiple unknowns", () => {
      const result = unknownPermissionKeys([
        "z:fly:ZUGEWIESEN",
        "a:swim:ZUGEWIESEN",
        "z:fly:ZUGEWIESEN",
      ]);
      expect(result).toEqual(["z:fly:ZUGEWIESEN", "a:swim:ZUGEWIESEN"]);
    });
  });

  describe("normalizeRolePermissions", () => {
    const keyA = permissionKey(PERMISSIONS[0]);
    const keyB = permissionKey(PERMISSIONS[1]);

    it("returns keys given in reverse catalog order with a duplicate as distinct, catalog-ordered", () => {
      expect(normalizeRolePermissions([keyB, keyA, keyB])).toEqual([keyA, keyB]);
    });

    it("keeps an empty input empty", () => {
      expect(normalizeRolePermissions([])).toEqual([]);
    });

    it("throws on an unknown key and names it in the message", () => {
      expect(() => normalizeRolePermissions(["role:fly:ZUGEWIESEN"])).toThrow(
        /role:fly:ZUGEWIESEN/,
      );
    });

    it("normalising twice equals normalising once (idempotent)", () => {
      const once = normalizeRolePermissions([keyB, keyA, keyB]);
      const twice = normalizeRolePermissions(once);
      expect(twice).toEqual(once);
    });
  });

  describe("roleGrants — AK-73-7/D-11: the one resolution path, identical for system and copy", () => {
    it("answers identically for a system role and an unchanged copy with a tenant, over the whole catalog, non-vacuously", () => {
      const threeKeys = normalizeRolePermissions([
        permissionKey(PERMISSIONS[0]),
        permissionKey(PERMISSIONS[1]),
        permissionKey(PERMISSIONS[2]),
      ]);
      const system = { tenantId: null, permissions: threeKeys };
      const copy = { tenantId: "tenant-x", permissions: [...threeKeys] };

      expect(copy.permissions).toEqual(system.permissions);

      const results = PERMISSIONS.map((p) => {
        const key = permissionKey(p);
        const systemResult = roleGrants(system, key);
        const copyResult = roleGrants(copy, key);
        expect(systemResult).toBe(copyResult);
        return systemResult;
      });

      expect(results.filter((r) => r === true).length).toBe(threeKeys.length);
      expect(results.some((r) => r === true)).toBe(true);
      expect(results.some((r) => r === false)).toBe(true);
    });

    it("is false for every catalog key on a role with an empty permission list", () => {
      const empty = { tenantId: null, permissions: [] as string[] };
      for (const p of PERMISSIONS) {
        expect(roleGrants(empty, permissionKey(p))).toBe(false);
      }
    });
  });

  describe("copyRoleName", () => {
    it('attempt 1 -> "<base> (Kopie)"', () => {
      expect(copyRoleName("Manager", 1)).toBe("Manager (Kopie)");
    });

    it('attempt 2 -> "<base> (Kopie 2)"', () => {
      expect(copyRoleName("Manager", 2)).toBe("Manager (Kopie 2)");
    });

    it("trims surrounding whitespace of the source", () => {
      expect(copyRoleName("  Manager  ", 1)).toBe("Manager (Kopie)");
    });

    it(`a ${ROLE_NAME_MAX_LENGTH}-character source gives <= ${ROLE_NAME_MAX_LENGTH} characters ending in " (Kopie)"`, () => {
      const longName = "x".repeat(ROLE_NAME_MAX_LENGTH);
      const result = copyRoleName(longName, 1);
      expect(result.length).toBeLessThanOrEqual(ROLE_NAME_MAX_LENGTH);
      expect(result.endsWith(" (Kopie)")).toBe(true);
    });

    it(`a ${ROLE_NAME_MAX_LENGTH}-character source at attempt 12 gives <= ${ROLE_NAME_MAX_LENGTH} characters ending in " (Kopie 12)"`, () => {
      const longName = "x".repeat(ROLE_NAME_MAX_LENGTH);
      const result = copyRoleName(longName, 12);
      expect(result.length).toBeLessThanOrEqual(ROLE_NAME_MAX_LENGTH);
      expect(result.endsWith(" (Kopie 12)")).toBe(true);
    });

    it("throws RangeError for attempt 0", () => {
      expect(() => copyRoleName("Manager", 0)).toThrow(RangeError);
    });

    it("throws RangeError for a non-integer attempt (1.5)", () => {
      expect(() => copyRoleName("Manager", 1.5)).toThrow(RangeError);
    });
  });

  describe("export surface", () => {
    it("contexts/platform/index.ts re-exports the same function objects (D-11)", () => {
      expect(platform.roleGrants).toBe(roleGrants);
      expect(platform.normalizeRolePermissions).toBe(normalizeRolePermissions);
      expect(platform.roleNameKey).toBe(roleNameKey);
    });
  });
});

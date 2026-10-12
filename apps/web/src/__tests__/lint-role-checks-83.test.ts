// Issue #83 (D-10/D-13) — the files Phase 83 converted from role checks to permissions are in the
// web role-check gate's scope, exist, carry no role check, and the gate still finds a real one.
import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import {
  ALLOWLIST,
  SCOPE_FILES,
  findRoleChecks,
  staleAllowlistEntries,
} from "../../scripts/lint-role-checks.mjs";

const REPO = resolve(process.cwd(), "..", "..");
const PHASE_83 = [
  "apps/web/src/routes/(app)/admin/+layout.svelte",
  "apps/web/src/routes/(app)/admin/+page.svelte",
  "apps/web/src/routes/(app)/admin/shifts/+page.svelte",
  "apps/web/src/routes/(app)/admin/availability/+page.svelte",
  "apps/web/src/routes/(app)/admin/availability/[employeeId]/+page.svelte",
  "apps/web/src/routes/(app)/admin/roles/+page.svelte",
  "apps/web/src/lib/nav/admin-route-permissions.ts",
  "apps/web/src/lib/api/roles.ts",
  "apps/web/src/lib/components/ui/CommandPalette.svelte",
  "apps/web/src/lib/components/layout/BottomTabBar.svelte",
];

describe("web role-check gate covers Phase 83 (Issue #83)", () => {
  it("lists every converted file, and each exists", () => {
    for (const file of PHASE_83) {
      expect(SCOPE_FILES).toContain(file);
      expect(existsSync(resolve(REPO, file)), file).toBe(true);
    }
  });

  it("finds no role check in the converted files", () => {
    for (const file of PHASE_83) {
      expect(findRoleChecks(readFileSync(resolve(REPO, file), "utf8")), file).toEqual([]);
    }
  });

  it("still flags a role comparison and a compat-role read", () => {
    expect(findRoleChecks('if (role === "ADMIN") {}').length).toBeGreaterThan(0);
    expect(findRoleChecks("const r = $authStore.user?.role;").length).toBeGreaterThan(0);
  });

  it("keeps only the two display-label exceptions and flags stale ones", () => {
    expect([...ALLOWLIST]).toHaveLength(2);
    const read = (file: string) => readFileSync(resolve(REPO, file), "utf8");
    expect(staleAllowlistEntries(ALLOWLIST, SCOPE_FILES, read)).toEqual([]);
    const outOfScope = "apps/web/src/no-such-file.svelte::x";
    const noMatch = "apps/web/src/lib/components/layout/Sidebar.svelte::no such line";
    expect(staleAllowlistEntries([outOfScope, noMatch], SCOPE_FILES, read)).toEqual([
      outOfScope,
      noMatch,
    ]);
  });
});

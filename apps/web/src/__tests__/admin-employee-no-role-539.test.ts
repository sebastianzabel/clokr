// Issue #539 (D-10, D-14) - the employee page for a person without a role. The page is not
// mountable in the web test setup (no `$app` alias in vitest.config.ts - see
// admin-employee-save-wiring.test.ts), so this pins by source read that it goes through the pure
// rules of lib/employees/form-role.ts and renders the placeholder and the hint.
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

function readRouteFile(relativeFromHere: string, relativeFromCwd: string): string {
  try {
    return readFileSync(fileURLToPath(new URL(relativeFromHere, import.meta.url)), "utf8");
  } catch {
    return readFileSync(resolve(process.cwd(), relativeFromCwd), "utf8");
  }
}

const PAGE = readRouteFile(
  "../routes/(app)/admin/employees/[id]/+page.svelte",
  "src/routes/(app)/admin/employees/[id]/+page.svelte",
);
const LIST = readRouteFile(
  "../routes/(app)/admin/employees/+page.svelte",
  "src/routes/(app)/admin/employees/+page.svelte",
);

describe("/admin/employees/[id] - a person without a role (Issue #539)", () => {
  // Issue #580 (D-580-04) retired the role select of this page together with its helpers
  // (initialFormRole, roleForSave, the eRole state, the empty first option); their absence is
  // asserted in admin-employee-role-assignments-580.test.ts. The display rules below still hold.
  it("imports the no-role rule and hint from form-role.ts", () => {
    expect(PAGE).toMatch(/import \{[^}]*\bhasNoRole\b[^}]*\} from "\$lib\/employees\/form-role"/);
    expect(PAGE).toMatch(
      /import \{[^}]*\bNO_ROLE_HINT\b[^}]*\} from "\$lib\/employees\/form-role"/,
    );
  });

  it("types the employee's user role as nullable and derives no default role", () => {
    expect(PAGE).toMatch(/role:\s*FormRole \| null;/);
    expect(PAGE).not.toMatch(/employee\.user\?\.role \?\? "EMPLOYEE"/);
  });

  it("renders the hint under hasNoRole, outside the canAssignRoles condition", () => {
    const tab = PAGE.slice(PAGE.indexOf('tab === "berechtigungen"'));
    const hintAt = tab.indexOf("{NO_ROLE_HINT}");
    expect(hintAt).toBeGreaterThan(-1);
    const guard = tab.lastIndexOf("{#if hasNoRole(accountUser)}", hintAt);
    expect(guard).toBeGreaterThan(-1);
    expect(hintAt - guard).toBeLessThan(300);
    // The permission block opens before the hint and is closed again before the hint's guard.
    const permissionBlock = tab.indexOf("{#if canAssignRoles}");
    expect(permissionBlock).toBeGreaterThan(-1);
    expect(permissionBlock).toBeLessThan(guard);
    const between = tab.slice(permissionBlock, guard);
    const opens = (between.match(/\{#if /g) ?? []).length;
    const closes = (between.match(/\{\/if\}/g) ?? []).length;
    expect(closes).toBe(opens);
    // Existing recipe, no invented class.
    expect(tab.slice(guard, hintAt)).toContain('class="callout"');
  });
});

describe("/admin/employees list - a person without a role (Issue #539)", () => {
  it("reads no role from the employee row; the chips come from the stored assignments only", () => {
    expect(LIST).not.toMatch(/\buser\??\.role\b/);
    // Issue #580: one chip per stored assignment, through the shared formatter
    expect(LIST).toContain("{#each assignmentsOf(emp) as assignment (assignment.id)}");
    expect(LIST).toContain("assignmentLabel(assignment, assignmentCtx)");
  });
});

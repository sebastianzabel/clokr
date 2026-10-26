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
  it("imports the rules from form-role.ts", () => {
    expect(PAGE).toMatch(
      /import \{[^}]*\b(initialFormRole|hasNoRole|roleForSave)\b[^}]*\} from "\$lib\/employees\/form-role"/,
    );
  });

  it("types the employee's user role as nullable and the form state with the empty choice", () => {
    expect(PAGE).toMatch(/role:\s*FormRole \| null;/);
    expect(PAGE).toMatch(/let eRole = \$state<FormRole \| "">\(""\);/);
  });

  it("initialises the form role from the server-derived role, with no default role", () => {
    expect(PAGE).toContain("eRole = initialFormRole(employee.user?.role ?? null);");
    expect(PAGE).not.toMatch(/employee\.user\?\.role \?\? "EMPLOYEE"/);
  });

  it("builds the PATCH body's role part through roleForSave", () => {
    expect(PAGE).toContain("...roleForSave(canAssignRoles, eRole)");
    expect(PAGE).not.toMatch(/canAssignRoles \? \{ role: eRole \} : \{\}/);
  });

  it("offers a disabled placeholder option „Keine Rolle zugewiesen“ first in the role select", () => {
    const select = PAGE.slice(PAGE.indexOf('<select id="e-role"'));
    const firstOption = select.slice(0, select.indexOf("</select>"));
    expect(firstOption).toMatch(/<option value="" disabled>Keine Rolle zugewiesen<\/option>/);
    expect(firstOption.indexOf('value=""')).toBeLessThan(firstOption.indexOf('value="EMPLOYEE"'));
  });

  it("renders the hint in the E-Mail/Status block, outside the canAssignRoles condition", () => {
    const hintAt = PAGE.indexOf("{NO_ROLE_HINT}");
    expect(hintAt).toBeGreaterThan(-1);
    const guard = PAGE.lastIndexOf("{#if hasNoRole(accountUser)}", hintAt);
    expect(guard).toBeGreaterThan(-1);
    expect(hintAt - guard).toBeLessThan(300);
    // The role select's own block ends before the hint block starts.
    const roleBlock = PAGE.indexOf("{#if canAssignRoles}");
    const roleBlockEnd = PAGE.indexOf("{/if}", roleBlock);
    expect(guard).toBeGreaterThan(roleBlockEnd);
    // Existing recipe, no invented class.
    expect(PAGE.slice(guard, hintAt)).toContain('class="callout"');
  });
});

describe("/admin/employees list - a person without a role (Issue #539)", () => {
  it("reads no role from the employee row; the chip comes from the assigned role names only", () => {
    expect(LIST).not.toMatch(/\buser\??\.role\b/);
    expect(LIST).toContain("(roleNamesOf(emp) ?? []).length > 0");
  });
});

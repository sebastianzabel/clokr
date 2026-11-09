// Issue #580 (D-580-01/04/05/07) — the employee pages use the one role-assignment building block.
// The route pages are not mountable in the web test setup (no `$app` alias), so the wiring is
// pinned by source read; the block's behaviour is proved mounted in PersonRoleAssignments.test.ts.
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

const DETAIL = readRouteFile(
  "../routes/(app)/admin/employees/[id]/+page.svelte",
  "src/routes/(app)/admin/employees/[id]/+page.svelte",
);
const LIST = readRouteFile(
  "../routes/(app)/admin/employees/+page.svelte",
  "src/routes/(app)/admin/employees/+page.svelte",
);

/** The body of `function <name>` (balanced braces). */
function fnBody(source: string, name: string): string {
  const start = source.indexOf(`function ${name}(`);
  expect(start, `function ${name} not found`).toBeGreaterThan(-1);
  const open = source.indexOf("{", start);
  let depth = 0;
  for (let i = open; i < source.length; i++) {
    if (source[i] === "{") depth++;
    if (source[i] === "}" && --depth === 0) return source.slice(open, i + 1);
  }
  throw new Error(`unbalanced function ${name}`);
}

describe("/admin/employees/[id] — Berechtigungen (#580)", () => {
  it("[vacuity gate] both pages are loaded", () => {
    expect(DETAIL.length).toBeGreaterThan(100_000);
    expect(LIST.length).toBeGreaterThan(20_000);
  });

  const start = DETAIL.indexOf('tab === "berechtigungen"');
  const end = DETAIL.indexOf('tab === "danger"');
  const tab = DETAIL.slice(start, end);

  it("renders the block for the employee's user, with a change handler", () => {
    expect(start).toBeGreaterThan(-1);
    expect(end).toBeGreaterThan(start);
    expect(tab).toContain("<PersonRoleAssignments");
    expect(tab).toContain("userId={employee.userId}");
    expect(tab).toContain("onChanged={onRoleAssignmentsChanged}");
  });

  it("has no role select, no save footer and no unsaved marker", () => {
    expect(tab).not.toContain("<select");
    expect(tab).not.toContain("dirty=");
    expect(tab).not.toContain("footer()");
  });

  it("no longer sends a role with the Stammdaten and has no select state", () => {
    expect(DETAIL).not.toMatch(/\beRole\b|roleForSave|initialFormRole|id="e-role"/);
    expect(DETAIL).not.toContain("Administrator");
    expect(fnBody(DETAIL, "saveStammdaten")).not.toMatch(/\brole\b/);
  });

  it("loads the assignments only with role-assignment:manage", () => {
    expect(DETAIL).toContain("listRoleAssignments(");
    expect(DETAIL).toMatch(/if \(!userId \|\| !canAssignRoles\) return;/);
  });

  it("never re-initialises the form after an assignment change", () => {
    expect(fnBody(DETAIL, "onRoleAssignmentsChanged")).not.toContain("initFields(");
  });
});

describe("/admin/employees — the Rolle column (#580)", () => {
  it("shows every stored assignment through the shared formatter", () => {
    expect(LIST).toContain('from "$lib/roles/assignment-label"');
    expect(LIST).toContain("assignmentLabel(assignment, assignmentCtx)");
    expect(LIST).toContain("{NO_ASSIGNMENT_LABEL}");
    expect(LIST).not.toContain("/role-assignments/role-names");
  });
});

describe("/admin/employees — create dialog (#580)", () => {
  it("sends no role with the new person and has no role select", () => {
    const payload = LIST.slice(
      LIST.indexOf("const payload"),
      LIST.indexOf("Object.assign(payload"),
    );
    expect(payload.length).toBeGreaterThan(200);
    expect(payload).not.toMatch(/\brole:/);
    expect(LIST).not.toMatch(/\bcRole\b|id="c-role"/);
    expect(LIST).not.toContain("Administrator");
  });

  it("drafts further roles in the shared block, after the fixed default role", () => {
    expect(LIST).toContain("bind:drafts={cDrafts}");
    expect(LIST).toContain("fixedRows={CREATE_FIXED_ROWS}");
    expect(LIST).toMatch(/roleName: CREATE_DEFAULT_ROLE_NAME, scope: \{ type: "TENANT" \}/);
  });

  it("posts the drafts for the created user and hands a refusal over to the tab", () => {
    expect(LIST).toContain("postAssignmentDrafts(res.userId, drafts)");
    expect(LIST).toContain("goto(berechtigungenTabHref(res.id))");
  });

  it("loads the role choices only with role-assignment:manage", () => {
    const body = fnBody(LIST, "loadCreateRoleChoices");
    const guard = body.indexOf("if (!canAssignRoles)");
    expect(guard).toBeGreaterThan(-1);
    expect(guard).toBeLessThan(body.indexOf("listAssignablePeople("));
  });
});

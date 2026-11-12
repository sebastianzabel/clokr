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
// Since Issue #854 (plan 854-20) the roles live in the Zugang tab component and the Stammdaten saves
// in the Person tab component.
const ZUGANG_TAB = readRouteFile(
  "../lib/components/employees/detail/ZugangTab.svelte",
  "src/lib/components/employees/detail/ZugangTab.svelte",
);
const PERSON_TAB = readRouteFile(
  "../lib/components/employees/detail/PersonTab.svelte",
  "src/lib/components/employees/detail/PersonTab.svelte",
);
const LIST = readRouteFile(
  "../routes/(app)/admin/employees/+page.svelte",
  "src/routes/(app)/admin/employees/+page.svelte",
);
// Since Issue #854 the create form is the guided dialog; its body comes from the create-person model.
const CREATE_DIALOG = readRouteFile(
  "../lib/components/employees/CreatePersonDialog.svelte",
  "src/lib/components/employees/CreatePersonDialog.svelte",
);
const CREATE_MODEL = readRouteFile(
  "../lib/employees/create-person.ts",
  "src/lib/employees/create-person.ts",
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
    expect(DETAIL.length).toBeGreaterThan(80_000);
    expect(LIST.length).toBeGreaterThan(20_000);
  });

  // The Zugang tab holds the roles first, then the login and the deletion groups (#854).
  const start = ZUGANG_TAB.indexOf('aria-labelledby="{uid}-roles"');
  const end = ZUGANG_TAB.indexOf('aria-labelledby="{uid}-login"');
  const tab = ZUGANG_TAB.slice(start, end);

  it("the page mounts the Zugang tab for the employee", () => {
    expect(DETAIL).toContain('tab === "zugang"');
    expect(DETAIL).toContain("<ZugangTab");
  });

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
    for (const name of ["saveIdentity", "saveStructure", "saveEmployment"]) {
      expect(fnBody(PERSON_TAB, name), name).not.toMatch(/\brole\b/);
    }
  });

  it("loads the assignments only with role-assignment:manage", () => {
    expect(ZUGANG_TAB).toContain("listRoleAssignments(");
    expect(ZUGANG_TAB).toMatch(/if \(!userId \|\| !rights\.canAssignRoles\) return;/);
  });

  it("never re-initialises the form after an assignment change", () => {
    expect(fnBody(ZUGANG_TAB, "onRoleAssignmentsChanged")).not.toContain("initFields(");
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
  it("[vacuity gate] the dialog and the model are loaded", () => {
    expect(CREATE_DIALOG.length).toBeGreaterThan(8_000);
    expect(CREATE_MODEL.length).toBeGreaterThan(3_000);
  });

  it("sends no role with the new person and has no role select", () => {
    const payload = CREATE_MODEL.slice(
      CREATE_MODEL.indexOf("const payload"),
      CREATE_MODEL.indexOf("Object.assign(payload"),
    );
    expect(payload.length).toBeGreaterThan(200);
    expect(payload).not.toMatch(/\brole:/);
    expect(CREATE_MODEL).not.toMatch(/\brole\b\s*:/);
    for (const source of [LIST, CREATE_DIALOG]) {
      expect(source).not.toMatch(/\bcRole\b|id="c-role"/);
      expect(source).not.toContain("Administrator");
    }
  });

  it("drafts further roles in the shared block, after the fixed default role", () => {
    expect(CREATE_DIALOG).toContain("bind:drafts={roleDrafts}");
    expect(CREATE_DIALOG).toContain("fixedRows={FIXED_ROWS}");
    expect(CREATE_DIALOG).toMatch(/roleName: CREATE_DEFAULT_ROLE_NAME, scope: \{ type: "TENANT"/);
  });

  it("posts the drafts for the created user and hands a refusal over to the tab", () => {
    expect(CREATE_DIALOG).toContain("postAssignmentDrafts(userId, drafts)");
    expect(CREATE_DIALOG).toContain("goto(berechtigungenTabHref(res.id))");
  });

  it("loads the role choices only with role-assignment:manage", () => {
    const body = fnBody(LIST, "loadCreateRoleChoices");
    const guard = body.indexOf("if (!canAssignRoles)");
    expect(guard).toBeGreaterThan(-1);
    expect(guard).toBeLessThan(body.indexOf("listAssignablePeople("));
  });

  it("the page hands the loaded choices to the dialog", () => {
    expect(LIST).toContain("roles={createRoles}");
    expect(LIST).toContain("mandantRoleIds={createMandantRoleIds}");
    expect(LIST).toContain("roleChoicesFailed={createRoleChoicesFailed}");
  });
});

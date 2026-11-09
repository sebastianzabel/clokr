// Issue #580 (D-580-02) — the one place of the role-assignment wording.
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

import type { RoleAssignment } from "$lib/api/roles";
import {
  CREATE_DEFAULT_ROLE_NAME,
  SCOPE_TENANT_LABEL,
  UNKNOWN_PERSON_LABEL,
  UNKNOWN_SALON_LABEL,
  assignedRoleNames,
  assignmentLabel,
  groupAssignmentsByUser,
  scopeLabel,
} from "../assignment-label";

const CTX = {
  salons: [
    { id: "s1", name: "Salon Eins" },
    { id: "s2", name: "Salon Zwei" },
  ],
  salonsLoaded: true,
  people: [{ employeeId: "e1", firstName: "Probe", lastName: "Eins" }],
};

function assignment(id: string, userId: string, roleName: string): RoleAssignment {
  return {
    id,
    userId,
    accessRoleId: `r-${roleName}`,
    roleName,
    isSystemRole: false,
    scope: { type: "TENANT" },
    createdAt: "",
    updatedAt: "",
  };
}

describe("scopeLabel", () => {
  it("names the whole company", () => {
    expect(scopeLabel({ type: "TENANT" }, CTX)).toBe("Ganzes Unternehmen");
    expect(SCOPE_TENANT_LABEL).toBe("Ganzes Unternehmen");
  });
  it("names the salons, a deactivated one with the fallback", () => {
    expect(scopeLabel({ type: "SALONS", salonIds: ["s1", "s2"] }, CTX)).toBe(
      "Salons: Salon Eins, Salon Zwei",
    );
    expect(scopeLabel({ type: "SALONS", salonIds: ["gone"] }, CTX)).toBe(
      `Salons: ${UNKNOWN_SALON_LABEL}`,
    );
  });
  it("never reads a salon as deactivated while the salon list loads", () => {
    expect(
      scopeLabel({ type: "SALONS", salonIds: ["gone"] }, { ...CTX, salonsLoaded: false }),
    ).toBe("Salons: …");
  });
  it("names the persons, a missing one with the fallback", () => {
    expect(scopeLabel({ type: "PERSONS", employeeIds: ["e1", "x"] }, CTX)).toBe(
      `Personen: Probe Eins, ${UNKNOWN_PERSON_LABEL}`,
    );
  });
});

describe("assignmentLabel and the helpers", () => {
  it("joins role and scope with a middle dot", () => {
    expect(
      assignmentLabel(
        { roleName: "Salonmanager", scope: { type: "SALONS", salonIds: ["s2"] } },
        CTX,
      ),
    ).toBe("Salonmanager · Salons: Salon Zwei");
  });
  it("dedupes and sorts role names", () => {
    expect(
      assignedRoleNames([
        { roleName: "Mitarbeiter" },
        { roleName: "Admin" },
        { roleName: "Admin" },
      ]),
    ).toEqual(["Admin", "Mitarbeiter"]);
  });
  it("groups by user in list order", () => {
    const grouped = groupAssignmentsByUser([
      assignment("a1", "u1", "A"),
      assignment("a2", "u2", "B"),
      assignment("a3", "u1", "C"),
    ]);
    expect(grouped.u1.map((a) => a.id)).toEqual(["a1", "a3"]);
    expect(grouped.u2.map((a) => a.id)).toEqual(["a2"]);
  });
  it("never shows a scope code", () => {
    const texts = [
      scopeLabel({ type: "TENANT" }, CTX),
      scopeLabel({ type: "SALONS", salonIds: ["s1"] }, CTX),
      scopeLabel({ type: "PERSONS", employeeIds: ["e1"] }, CTX),
    ].join(" ");
    expect(texts).not.toMatch(/TENANT|SALONS|PERSONS/);
  });
});

describe("the create default role equals the API's system role name", () => {
  it("SYSTEM_ROLE_NAMES.EMPLOYEE of the API is CREATE_DEFAULT_ROLE_NAME", () => {
    const here = path.dirname(fileURLToPath(import.meta.url));
    const source = readFileSync(
      path.resolve(here, "../../../../../api/src/contexts/platform/system-roles.ts"),
      "utf8",
    );
    expect(source.length).toBeGreaterThan(1000);
    const block = /SYSTEM_ROLE_NAMES[\s\S]*?\}\)/.exec(source)?.[0] ?? "";
    expect(block).toContain(`EMPLOYEE: "${CREATE_DEFAULT_ROLE_NAME}"`);
  });
});

// Issue #83 (D-09) — the role draft: dirty detection is order-independent and ignores whitespace
// around the name; the request body carries the selected keys in catalog order.
import { describe, it, expect } from "vitest";
import { draftDirty, draftFromRole, newRoleDraft, orderedKeys } from "../role-draft";

const ROLE = {
  id: "r1",
  name: "Teamleitung",
  permissions: ["b:read:ZUGEWIESEN", "a:read:EIGENE"],
  isSystem: false,
  createdAt: "",
  updatedAt: "",
};

const GROUPS = [
  {
    resource: "a",
    label: "A",
    permissions: [
      { key: "a:read:EIGENE", label: "A1", reach: "EIGENE" as const, relation: "PERSON" as const },
    ],
  },
  {
    resource: "b",
    label: "B",
    permissions: [
      {
        key: "b:read:ZUGEWIESEN",
        label: "B1",
        reach: "ZUGEWIESEN" as const,
        relation: "PERSON" as const,
      },
      {
        key: "b:manage:ZUGEWIESEN",
        label: "B2",
        reach: "ZUGEWIESEN" as const,
        relation: "MANDANT" as const,
      },
    ],
  },
];

describe("role draft (Issue #83)", () => {
  it("an untouched draft is clean, new or loaded", () => {
    expect(draftDirty(newRoleDraft())).toBe(false);
    expect(draftDirty(draftFromRole(ROLE))).toBe(false);
  });

  it("a name change is dirty, a whitespace-only change is not", () => {
    const draft = draftFromRole(ROLE);
    expect(draftDirty({ ...draft, name: "Andere" })).toBe(true);
    expect(draftDirty({ ...draft, name: "  Teamleitung " })).toBe(false);
  });

  it("toggling a key is dirty, toggling it back is clean, order does not matter", () => {
    const draft = draftFromRole(ROLE);
    const added = { ...draft, permissions: [...draft.permissions, "b:manage:ZUGEWIESEN"] };
    expect(draftDirty(added)).toBe(true);
    expect(draftDirty({ ...added, permissions: ["a:read:EIGENE", "b:read:ZUGEWIESEN"] })).toBe(
      false,
    );
  });

  it("orderedKeys returns the selection in catalog order", () => {
    expect(orderedKeys(GROUPS, ["b:manage:ZUGEWIESEN", "a:read:EIGENE"])).toEqual([
      "a:read:EIGENE",
      "b:manage:ZUGEWIESEN",
    ]);
    expect(orderedKeys(GROUPS, [])).toEqual([]);
  });
});

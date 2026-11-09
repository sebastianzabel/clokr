// Issue #580 (D-580-03) — posting the create dialog's drafts once the person exists.
vi.mock("$api/client", () => {
  class ApiError extends Error {
    constructor(
      public status: number,
      message: string,
    ) {
      super(message);
    }
  }
  return { ApiError, api: { get: vi.fn(), post: vi.fn(), patch: vi.fn(), delete: vi.fn() } };
});

import { describe, expect, it, vi } from "vitest";
import { ApiError } from "$api/client";
import type { AccessRole, AssignmentDraft } from "$lib/api/roles";
import { employeeDetailTabs } from "$lib/employees/detail-tabs";
import { assignmentLabel } from "../assignment-label";
import {
  berechtigungenTabHref,
  draftFailureMessage,
  draftLabel,
  draftsSavedMessage,
  postAssignmentDrafts,
} from "../assignment-drafts";

const D1: AssignmentDraft = { key: "k1", accessRoleId: "r1", scope: { type: "TENANT" } };
const D2: AssignmentDraft = {
  key: "k2",
  accessRoleId: "r2",
  scope: { type: "SALONS", salonIds: ["s1"] },
};
const D3: AssignmentDraft = { key: "k3", accessRoleId: "r3", scope: { type: "TENANT" } };
const ROLES = [{ id: "r2", name: "Salonmanager" }] as AccessRole[];
const CTX = { salons: [{ id: "s1", name: "Salon Nord" }], salonsLoaded: true, people: [] };

describe("postAssignmentDrafts", () => {
  it("posts each draft in order for the new user", async () => {
    const post = vi.fn().mockResolvedValue({});
    expect(await postAssignmentDrafts("u1", [D1, D2], post)).toEqual([]);
    expect(post.mock.calls.map((c) => c[0])).toEqual([
      { userId: "u1", accessRoleId: "r1", scope: D1.scope },
      { userId: "u1", accessRoleId: "r2", scope: D2.scope },
    ]);
  });
  it("keeps going after a refusal and returns it with the server's message", async () => {
    const post = vi
      .fn()
      .mockResolvedValueOnce({})
      .mockRejectedValueOnce(new ApiError(409, "Paket nicht gebucht"))
      .mockResolvedValueOnce({});
    const failures = await postAssignmentDrafts("u1", [D1, D2, D3], post);
    expect(post).toHaveBeenCalledTimes(3);
    expect(failures).toEqual([{ draft: D2, message: "Paket nicht gebucht" }]);
  });
  it("gives a generic text for an unexpected error", async () => {
    const post = vi.fn().mockRejectedValue(new Error("boom"));
    const [failure] = await postAssignmentDrafts("u1", [D1], post);
    expect(failure.message).toBe("Die Anfrage ist fehlgeschlagen. Bitte versuch es noch einmal.");
  });
  it("posts nothing without drafts", async () => {
    const post = vi.fn();
    expect(await postAssignmentDrafts("u1", [], post)).toEqual([]);
    expect(post).not.toHaveBeenCalled();
  });
});

describe("the messages and the hand-over", () => {
  it("words a draft like a stored assignment", () => {
    expect(draftLabel(D2, ROLES, CTX)).toBe(
      assignmentLabel({ roleName: "Salonmanager", scope: D2.scope }, CTX),
    );
  });
  it("names one or several refused drafts", () => {
    expect(draftFailureMessage([{ label: "A · Ganzes Unternehmen", message: "x" }])).toBe(
      "Die Person ist angelegt. Diese Rolle wurde nicht zugewiesen: A · Ganzes Unternehmen (x)",
    );
    expect(
      draftFailureMessage([
        { label: "A", message: "x" },
        { label: "B", message: "y" },
      ]),
    ).toBe("Die Person ist angelegt. Diese Rollen wurden nicht zugewiesen: A (x); B (y)");
  });
  it("confirms one or several saved drafts", () => {
    expect(draftsSavedMessage(1)).toBe("Rolle zugewiesen");
    expect(draftsSavedMessage(2)).toBe("Rollen zugewiesen");
  });
  it("hands over to a real tab of the detail page", () => {
    const href = berechtigungenTabHref("a/b");
    expect(href).toBe("/admin/employees/a%2Fb#berechtigungen");
    const ids = employeeDetailTabs({
      canManageAccess: true,
      canAssignRoles: true,
      canAnonymize: true,
    } as Parameters<typeof employeeDetailTabs>[0]).map((t) => t.id);
    expect(ids).toContain(href.split("#")[1]);
  });
});

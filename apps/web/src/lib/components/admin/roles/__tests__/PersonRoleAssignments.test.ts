// Issue #580 (D-580-01/D-580-07) — the one role-assignment building block, mounted: show, grant,
// change and revoke one person's assignments; permissions disable the actions; every label comes
// from assignment-label.ts. No person names in fixtures.
vi.mock("$stores/auth", () => ({ authStore: { subscribe: () => () => {} } }));

const apiPost = vi.fn();
const apiPatch = vi.fn();
const apiDelete = vi.fn();
vi.mock("$api/client", () => {
  class ApiError extends Error {
    constructor(
      public status: number,
      message: string,
      public data?: unknown,
    ) {
      super(message);
    }
  }
  return {
    ApiError,
    api: {
      get: vi.fn(),
      post: (...args: unknown[]) => apiPost(...args),
      patch: (...args: unknown[]) => apiPatch(...args),
      delete: (...args: unknown[]) => apiDelete(...args),
    },
  };
});

import { beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, screen, waitFor, within } from "@testing-library/svelte";
import { renderWithTheme } from "$tests/test-utils";
import { ApiError } from "$api/client";
import {
  ASSIGN_RIGHT_REQUIRED_NOTE,
  ROLE_READ_REQUIRED_NOTE,
  scopeLabel,
} from "$lib/roles/assignment-label";
import type { AssignmentScope } from "$lib/api/roles";
import PersonRoleAssignments from "../PersonRoleAssignments.svelte";

const ROLE = {
  id: "r-probe",
  name: "Probe-Rolle",
  permissions: ["employee:read:ZUGEWIESEN"],
  isSystem: false,
  createdAt: "",
  updatedAt: "",
};
const SYSTEM = { ...ROLE, id: "r-sys", name: "Systemprobe", isSystem: true };
const SALONS = [{ id: "s1", name: "Salon Nord" }];
const PEOPLE = [
  { employeeId: "e1", userId: "u1", firstName: "Probe", lastName: "Eins", isActive: true },
];

function item(id: string, role = ROLE, scope: unknown = { type: "TENANT" }) {
  return {
    id,
    userId: "u1",
    accessRoleId: role.id,
    roleName: role.name,
    isSystemRole: role.isSystem,
    scope,
    createdAt: "",
    updatedAt: "",
  };
}

const onChanged = vi.fn();

function mount(props: Record<string, unknown> = {}) {
  return renderWithTheme(PersonRoleAssignments, {
    personName: "Probe Eins",
    userId: "u1",
    items: [],
    onChanged,
    roles: [ROLE, SYSTEM],
    mandantRoleIds: [],
    salons: SALONS,
    salonsLoaded: true,
    people: PEOPLE,
    canManage: true,
    canReadRoles: true,
    ...props,
  });
}

beforeEach(() => {
  apiPost.mockReset();
  apiPatch.mockReset();
  apiDelete.mockReset();
  onChanged.mockReset();
});

describe("PersonRoleAssignments (Issue #580)", () => {
  it("tracer: an empty person, grant for the whole company, onChanged once", async () => {
    apiPost.mockResolvedValue(item("a1"));
    mount();
    expect(screen.getByText("Keine Rolle zugewiesen")).toBeInTheDocument();
    await fireEvent.click(screen.getByRole("button", { name: "Rolle zuweisen" }));
    const dialog = screen.getByRole("dialog");
    await fireEvent.change(within(dialog).getByLabelText("Rolle"), {
      target: { value: "r-probe" },
    });
    await fireEvent.click(within(dialog).getByRole("button", { name: "Speichern" }));
    await waitFor(() => expect(onChanged).toHaveBeenCalledTimes(1));
    expect(apiPost).toHaveBeenCalledWith("/role-assignments", {
      userId: "u1",
      accessRoleId: "r-probe",
      scope: { type: "TENANT" },
    });
  });

  it("shows role, system chip and exactly the shared scope wording", () => {
    const salonScope: AssignmentScope = { type: "SALONS", salonIds: ["s1"] };
    mount({ items: [item("a1", SYSTEM), item("a2", ROLE, salonScope)] });
    expect(screen.getByText("Systemrolle")).toBeInTheDocument();
    expect(screen.getAllByText("Systemrolle")).toHaveLength(1);
    const ctx = { salons: SALONS, salonsLoaded: true, people: PEOPLE };
    expect(screen.getByText(scopeLabel({ type: "TENANT" }, ctx))).toBeInTheDocument();
    expect(screen.getByText(scopeLabel(salonScope, ctx))).toBeInTheDocument();
  });

  it("changes an assignment through the prefilled dialog", async () => {
    apiPatch.mockResolvedValue(item("a1"));
    mount({ items: [item("a1")] });
    await fireEvent.click(screen.getByRole("button", { name: "Ändern" }));
    const dialog = screen.getByRole("dialog");
    expect(within(dialog).getByLabelText("Rolle")).toHaveValue("r-probe");
    await fireEvent.click(within(dialog).getByRole("button", { name: "Speichern" }));
    await waitFor(() => expect(onChanged).toHaveBeenCalledTimes(1));
    expect(apiPatch).toHaveBeenCalledWith("/role-assignments/a1", expect.any(Object));
  });

  it("revokes after confirmation", async () => {
    apiDelete.mockResolvedValue(undefined);
    mount({ items: [item("a1")] });
    await fireEvent.click(screen.getByRole("button", { name: "Entziehen" }));
    const confirm = screen.getByRole("dialog");
    await fireEvent.click(within(confirm).getByRole("button", { name: "Entziehen" }));
    await waitFor(() => expect(onChanged).toHaveBeenCalledTimes(1));
    expect(apiDelete).toHaveBeenCalledWith("/role-assignments/a1");
  });

  it("shows a refused revoke and never throws or reports a change", async () => {
    apiDelete.mockRejectedValue(new ApiError(409, "Die letzte Admin-Zuweisung bleibt."));
    mount({ items: [item("a1")] });
    await fireEvent.click(screen.getByRole("button", { name: "Entziehen" }));
    await fireEvent.click(
      within(screen.getByRole("dialog")).getByRole("button", { name: "Entziehen" }),
    );
    expect(await screen.findByRole("alert")).toHaveTextContent(
      "Die letzte Admin-Zuweisung bleibt.",
    );
    expect(onChanged).not.toHaveBeenCalled();
  });

  it("without role:read: grant and change disabled, revoke possible, the note shown", () => {
    mount({ items: [item("a1")], canReadRoles: false });
    expect(screen.getByRole("button", { name: "Rolle zuweisen" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "Ändern" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "Entziehen" })).toBeEnabled();
    expect(screen.getByText(ROLE_READ_REQUIRED_NOTE)).toBeInTheDocument();
  });

  it("the host can show the note once instead", () => {
    mount({ items: [item("a1")], canReadRoles: false, permissionNote: false });
    expect(screen.queryByText(ROLE_READ_REQUIRED_NOTE)).toBeNull();
  });

  it("without role-assignment:manage every action is disabled", () => {
    mount({ items: [item("a1")], canManage: false });
    expect(screen.getByRole("button", { name: "Rolle zuweisen" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "Ändern" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "Entziehen" })).toBeDisabled();
    expect(screen.getByText(ASSIGN_RIGHT_REQUIRED_NOTE)).toBeInTheDocument();
  });

  it("can hide the grant button and shows no codes", () => {
    const { container } = mount({ items: [item("a1")], allowGrant: false });
    expect(screen.queryByRole("button", { name: "Rolle zuweisen" })).toBeNull();
    expect(container.textContent ?? "").not.toMatch(/TENANT|SALONS|PERSONS|:ZUGEWIESEN/);
  });
});

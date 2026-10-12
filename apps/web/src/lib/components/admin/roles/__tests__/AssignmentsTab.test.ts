// Issue #83 (AK-4; D-03, D-05, D-08, D-15) — the „Zuweisungen“ tab, mounted: grant a role for the
// whole tenant, selected salons or selected people; edit and revoke; inactive salons and missing
// people stay visible; tenant-only rights get an explanation for narrower scopes; without
// role:read granting and changing are visibly disabled. No person names in fixtures.
vi.mock("$stores/auth", () => ({ authStore: { subscribe: () => () => {} } }));

const apiGet = vi.fn();
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
      get: (...args: unknown[]) => apiGet(...args),
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
import AssignmentsTab from "../AssignmentsTab.svelte";

const P1 = { employeeId: "e1", userId: "u1", firstName: "Probe", lastName: "Eins", isActive: true };
const P2 = { employeeId: "e2", userId: "u2", firstName: "Probe", lastName: "Zwei", isActive: true };
const ADMIN = {
  id: "r-admin",
  name: "Admin",
  permissions: ["role:read:ZUGEWIESEN", "employee:read:ZUGEWIESEN"],
  isSystem: true,
  createdAt: "",
  updatedAt: "",
};
const PROBE = {
  id: "r-probe",
  name: "Probe-Rolle",
  permissions: ["employee:read:ZUGEWIESEN"],
  isSystem: false,
  createdAt: "",
  updatedAt: "",
};
const CATALOG = [
  {
    resource: "employee",
    label: "Personen",
    permissions: [
      {
        key: "employee:read:ZUGEWIESEN",
        label: "Personen lesen",
        reach: "ZUGEWIESEN",
        relation: "PERSON",
      },
    ],
  },
  {
    resource: "role",
    label: "Rollen",
    permissions: [
      {
        key: "role:read:ZUGEWIESEN",
        label: "Rollen lesen",
        reach: "ZUGEWIESEN",
        relation: "MANDANT",
      },
    ],
  },
];
const SALONS = [
  { id: "s1", name: "Salon Nord" },
  { id: "s2", name: "Salon Süd" },
];
const MANDANT_HINT = /nur bei einer Zuweisung für den ganzen Mandanten wirken/;

let assignments: unknown[] = [];

function assignment(id: string, userId: string, role: typeof PROBE, scope: unknown) {
  return {
    id,
    userId,
    accessRoleId: role.id,
    roleName: role.name,
    isSystemRole: role.isSystem,
    scope,
    createdAt: "",
    updatedAt: "",
  };
}

beforeEach(() => {
  apiGet.mockReset();
  apiPost.mockReset();
  apiPatch.mockReset();
  apiDelete.mockReset();
  assignments = [];
  apiGet.mockImplementation((path: string) => {
    if (path === "/role-assignments/people") return Promise.resolve([P1, P2]);
    if (path === "/role-assignments") return Promise.resolve(assignments);
    if (path === "/roles") return Promise.resolve([ADMIN, PROBE]);
    if (path === "/roles/permission-catalog") return Promise.resolve(CATALOG);
    return Promise.reject(new Error(`unexpected GET ${path}`));
  });
});

async function mount(canReadRoles = true, salonsLoaded = true) {
  renderWithTheme(AssignmentsTab, { canReadRoles, salons: SALONS, salonsLoaded });
  await screen.findByText("Probe Eins");
}

function personBlock(name: string): HTMLElement {
  return screen
    .getByText(name, { selector: ".assignments-name" })
    .closest(".assignments-person") as HTMLElement;
}

async function openGrant(name = "Probe Eins") {
  await fireEvent.click(within(personBlock(name)).getByRole("button", { name: "Rolle zuweisen" }));
  return screen.getByRole("dialog");
}

async function chooseRole(dialog: HTMLElement, roleId: string) {
  await fireEvent.change(within(dialog).getByLabelText("Rolle"), { target: { value: roleId } });
}

describe("AssignmentsTab (Issue #83)", () => {
  it("tracer: grant a role for the whole tenant", async () => {
    await mount();
    expect(screen.getAllByText("Keine gespeicherte Zuweisung")).toHaveLength(2);
    const dialog = await openGrant();
    expect(within(dialog).getByRole("radio", { name: "Ganzer Mandant" })).toBeChecked();
    await chooseRole(dialog, "r-probe");
    apiPost.mockImplementationOnce(() => {
      assignments = [assignment("a1", "u1", PROBE, { type: "TENANT" })];
      return Promise.resolve(assignments[0]);
    });
    await fireEvent.click(within(dialog).getByRole("button", { name: "Speichern" }));
    await waitFor(() =>
      expect(apiPost).toHaveBeenCalledWith("/role-assignments", {
        userId: "u1",
        accessRoleId: "r-probe",
        scope: { type: "TENANT" },
      }),
    );
    expect(apiPost).toHaveBeenCalledTimes(1);
    await waitFor(() =>
      expect(within(personBlock("Probe Eins")).getByText("Ganzer Mandant")).toBeInTheDocument(),
    );
  });

  it("SALONS scope: save waits for a salon, sends the ticked ids", async () => {
    await mount();
    const dialog = await openGrant();
    await chooseRole(dialog, "r-probe");
    await fireEvent.click(within(dialog).getByRole("radio", { name: "Ausgewählte Salons" }));
    expect(within(dialog).getByRole("button", { name: "Speichern" })).toBeDisabled();
    await fireEvent.click(within(dialog).getByLabelText("Salon Nord"));
    await fireEvent.click(within(dialog).getByLabelText("Salon Süd"));
    apiPost.mockResolvedValueOnce({});
    await fireEvent.click(within(dialog).getByRole("button", { name: "Speichern" }));
    await waitFor(() =>
      expect(apiPost).toHaveBeenCalledWith("/role-assignments", {
        userId: "u1",
        accessRoleId: "r-probe",
        scope: { type: "SALONS", salonIds: ["s1", "s2"] },
      }),
    );
  });

  it("PERSONS scope: filter narrows the list, ticked people are sent", async () => {
    await mount();
    const dialog = await openGrant();
    await chooseRole(dialog, "r-probe");
    await fireEvent.click(within(dialog).getByRole("radio", { name: "Ausgewählte Personen" }));
    await fireEvent.input(within(dialog).getByLabelText("Person suchen"), {
      target: { value: "zwe" },
    });
    expect(within(dialog).queryByLabelText("Probe Eins")).toBeNull();
    await fireEvent.click(within(dialog).getByLabelText("Probe Zwei"));
    apiPost.mockResolvedValueOnce({});
    await fireEvent.click(within(dialog).getByRole("button", { name: "Speichern" }));
    await waitFor(() =>
      expect(apiPost).toHaveBeenCalledWith("/role-assignments", {
        userId: "u1",
        accessRoleId: "r-probe",
        scope: { type: "PERSONS", employeeIds: ["e2"] },
      }),
    );
  });

  it("an inactive salon is named, pre-checked on edit and can be removed", async () => {
    assignments = [assignment("a1", "u1", PROBE, { type: "SALONS", salonIds: ["s1", "s9"] })];
    await mount();
    expect(
      within(personBlock("Probe Eins")).getByText("Salons: Salon Nord, Salon nicht mehr aktiv"),
    ).toBeInTheDocument();
    await fireEvent.click(
      within(personBlock("Probe Eins")).getByRole("button", { name: "Ändern" }),
    );
    const dialog = screen.getByRole("dialog");
    const inactive = within(dialog).getByLabelText("Salon nicht mehr aktiv");
    expect(inactive).toBeChecked();
    await fireEvent.click(inactive);
    apiPatch.mockResolvedValueOnce({});
    await fireEvent.click(within(dialog).getByRole("button", { name: "Speichern" }));
    await waitFor(() =>
      expect(apiPatch).toHaveBeenCalledWith("/role-assignments/a1", {
        accessRoleId: "r-probe",
        scope: { type: "SALONS", salonIds: ["s1"] },
      }),
    );
  });

  it("before the salon context has loaded, no stored salon is marked inactive and save waits", async () => {
    assignments = [assignment("a1", "u1", PROBE, { type: "SALONS", salonIds: ["s1"] })];
    await mount(true, false);
    await fireEvent.click(
      within(personBlock("Probe Eins")).getByRole("button", { name: "Ändern" }),
    );
    const dialog = screen.getByRole("dialog");
    expect(within(dialog).queryByText("Salon nicht mehr aktiv")).toBeNull();
    expect(within(dialog).getByText("Salons werden geladen …")).toBeInTheDocument();
    expect(within(dialog).getByRole("button", { name: "Speichern" })).toBeDisabled();
  });

  it("tenant-only rights get an explanation for a salon or person scope, not for the tenant (D-03)", async () => {
    await mount();
    const dialog = await openGrant();
    await chooseRole(dialog, "r-admin");
    expect(within(dialog).queryByText(MANDANT_HINT)).toBeNull();
    await fireEvent.click(within(dialog).getByRole("radio", { name: "Ausgewählte Salons" }));
    expect(within(dialog).getByText(MANDANT_HINT)).toBeInTheDocument();
    await fireEvent.click(within(dialog).getByRole("radio", { name: "Ausgewählte Personen" }));
    expect(within(dialog).getByText(MANDANT_HINT)).toBeInTheDocument();
    await chooseRole(dialog, "r-probe");
    expect(within(dialog).queryByText(MANDANT_HINT)).toBeNull();
  });

  it("a duplicate is rejected with the server text inside the open dialog", async () => {
    await mount();
    const dialog = await openGrant();
    await chooseRole(dialog, "r-probe");
    const MSG = "Diese Rolle ist dem Nutzer mit diesem Scope-Typ bereits zugewiesen.";
    apiPost.mockRejectedValueOnce(new ApiError(409, MSG, { error: MSG }));
    await fireEvent.click(within(dialog).getByRole("button", { name: "Speichern" }));
    expect(await within(dialog).findByRole("alert")).toHaveTextContent(MSG);
    expect(screen.getByRole("dialog")).toBeInTheDocument();
  });

  it("revoke goes through a confirmation; a rejection is shown, never thrown", async () => {
    assignments = [assignment("a1", "u1", PROBE, { type: "TENANT" })];
    await mount();
    await fireEvent.click(
      within(personBlock("Probe Eins")).getByRole("button", { name: "Entziehen" }),
    );
    expect(
      await screen.findByText(/Probe Eins verliert die Rolle „Probe-Rolle“/),
    ).toBeInTheDocument();
    const MSG = "Diese Änderung würde dem Mandanten das letzte Recht zur Rollenverwaltung nehmen.";
    apiDelete.mockRejectedValueOnce(new ApiError(409, MSG, { error: MSG }));
    await fireEvent.click(
      within(screen.getByRole("dialog")).getByRole("button", { name: "Entziehen" }),
    );
    expect(await screen.findByRole("alert")).toHaveTextContent(MSG);

    apiDelete.mockImplementationOnce(() => {
      assignments = [];
      return Promise.resolve(undefined);
    });
    await fireEvent.click(
      within(personBlock("Probe Eins")).getByRole("button", { name: "Entziehen" }),
    );
    await fireEvent.click(
      within(screen.getByRole("dialog")).getByRole("button", { name: "Entziehen" }),
    );
    await waitFor(() => expect(apiDelete).toHaveBeenLastCalledWith("/role-assignments/a1"));
    await waitFor(() =>
      expect(screen.getAllByText("Keine gespeicherte Zuweisung")).toHaveLength(2),
    );
  });

  it("summaries name people, missing people and users without a profile", async () => {
    assignments = [
      assignment("a1", "u1", PROBE, { type: "PERSONS", employeeIds: ["e2", "e9"] }),
      assignment("a2", "u-orphan", PROBE, { type: "TENANT" }),
    ];
    await mount();
    expect(
      within(personBlock("Probe Eins")).getByText(
        "Personen: Probe Zwei, Person nicht mehr verfügbar",
      ),
    ).toBeInTheDocument();
    const orphan = personBlock("Nutzer ohne Mitarbeiterprofil");
    expect(within(orphan).getByRole("button", { name: "Ändern" })).toBeInTheDocument();
    expect(within(orphan).getByRole("button", { name: "Entziehen" })).toBeInTheDocument();
  });

  it("the person filter narrows the list", async () => {
    await mount();
    await fireEvent.input(screen.getByLabelText("Person suchen"), { target: { value: "zwei" } });
    expect(screen.queryByText("Probe Eins", { selector: ".assignments-name" })).toBeNull();
    expect(screen.getByText("Probe Zwei", { selector: ".assignments-name" })).toBeInTheDocument();
  });

  it("without role:read: no role reads, an explanation, granting disabled, revoking possible (D-15)", async () => {
    assignments = [assignment("a1", "u1", PROBE, { type: "TENANT" })];
    await mount(false);
    const paths = apiGet.mock.calls.map((c) => c[0]);
    expect(paths).not.toContain("/roles");
    expect(paths).not.toContain("/roles/permission-catalog");
    expect(
      screen.getByText(/brauchen Sie zusätzlich das Recht, Rollen zu lesen/),
    ).toBeInTheDocument();
    for (const button of screen.getAllByRole("button", { name: "Rolle zuweisen" })) {
      expect(button).toBeDisabled();
    }
    expect(screen.getByRole("button", { name: "Ändern" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "Entziehen" })).toBeEnabled();
  });

  it("never shows a raw permission key", async () => {
    await mount();
    await openGrant();
    expect(document.body.textContent ?? "").not.toMatch(/:(EIGENE|ZUGEWIESEN)/);
  });
});

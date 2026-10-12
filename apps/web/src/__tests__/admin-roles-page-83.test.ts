// Issue #83 (D-01, D-06, D-09) — the /admin/roles page, mounted: its tabs follow the caller's
// permissions, a caller without role rights gets an explanation and no API call, and the
// page-owned draft keeps the unsaved marker registered. The route guard itself is the admin route
// map (tested separately); the API decides every request anyway.
vi.mock("$stores/auth", async () => {
  const { writable } = await import("svelte/store");
  return { authStore: writable({ user: null }) };
});

const apiGet = vi.fn();
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
  return { ApiError, api: { get: (...args: unknown[]) => apiGet(...args) } };
});

import { beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, screen, waitFor } from "@testing-library/svelte";
import { renderWithTheme } from "$tests/test-utils";
import { authStore } from "$stores/auth";
import { hasUnsaved, markUnsaved } from "$stores/unsaved";
import RolesPage from "../routes/(app)/admin/roles/+page.svelte";

const CATALOG = [
  {
    resource: "employee",
    label: "Gruppe Personen",
    permissions: [
      {
        key: "employee:read:EIGENE",
        label: "Testbeschriftung Eins",
        reach: "EIGENE",
        relation: "PERSON",
      },
    ],
  },
];
const ROLES = [
  {
    id: "r-team",
    name: "Teamleitung",
    permissions: [],
    isSystem: false,
    createdAt: "",
    updatedAt: "",
  },
];

function asUser(permissions: string[]) {
  (authStore as unknown as { set: (v: unknown) => void }).set({
    user: {
      id: "u1",
      email: "u1@test.de",
      role: "EMPLOYEE",
      employeeId: "e1",
      firstName: null,
      permissions,
    },
  });
}

beforeEach(() => {
  apiGet.mockReset();
  markUnsaved("admin-roles", false);
  apiGet.mockImplementation((path: string) =>
    Promise.resolve(path === "/roles/permission-catalog" ? CATALOG : ROLES),
  );
});

describe("/admin/roles page (Issue #83)", () => {
  it("role:read + role:manage: title, the Rollen tab and the list", async () => {
    asUser(["role:read:ZUGEWIESEN", "role:manage:ZUGEWIESEN"]);
    renderWithTheme(RolesPage, {});
    expect(screen.getByRole("heading", { level: 1 })).toHaveTextContent("Rollen & Rechte");
    expect(screen.getByRole("tab", { name: "Rollen" })).toBeInTheDocument();
    expect(await screen.findByText("Teamleitung")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Neue Rolle" })).toBeEnabled();
  });

  it("role:read only: the tab is there, writing is visibly disabled", async () => {
    asUser(["role:read:ZUGEWIESEN"]);
    renderWithTheme(RolesPage, {});
    await screen.findByText("Teamleitung");
    expect(screen.getByRole("button", { name: "Neue Rolle" })).toBeDisabled();
  });

  it("no role right: an explanation and no API call", async () => {
    asUser(["time-entry:read:EIGENE"]);
    renderWithTheme(RolesPage, {});
    expect(screen.getByRole("alert")).toHaveTextContent(
      "Für diese Seite fehlen Ihnen die Berechtigungen.",
    );
    expect(apiGet).not.toHaveBeenCalled();
  });

  it("an edited draft registers the unsaved marker until it is discarded", async () => {
    asUser(["role:read:ZUGEWIESEN", "role:manage:ZUGEWIESEN"]);
    renderWithTheme(RolesPage, {});
    await screen.findByText("Teamleitung");
    await fireEvent.click(screen.getByRole("button", { name: "Bearbeiten" }));
    expect(hasUnsaved()).toBe(false);
    await fireEvent.click(screen.getByLabelText("Testbeschriftung Eins"));
    await waitFor(() => expect(hasUnsaved()).toBe(true));
    await fireEvent.click(screen.getByRole("button", { name: "Verwerfen" }));
    await waitFor(() => expect(hasUnsaved()).toBe(false));
  });
});

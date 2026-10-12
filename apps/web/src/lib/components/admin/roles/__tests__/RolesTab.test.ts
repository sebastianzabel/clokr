// Issue #83 (D-02, D-03, D-06, D-07, D-08, D-09) — the „Rollen“ tab, mounted: create from catalog
// labels, system roles visibly locked and copyable, the four-eyes confirmation on create, update
// and copy, delete through a confirmation, every other rejection shown with the server text.
// `$api/client` is mocked with a real-shaped ApiError so `isFourEyesConfirmation` sees the same
// class the component catches; `$stores/auth` is mocked because `$api/client` pulls it in.
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

import { describe, it, expect, vi, beforeEach } from "vitest";
import { screen, fireEvent, waitFor, within } from "@testing-library/svelte";
import { renderWithTheme } from "$tests/test-utils";
import { ApiError } from "$api/client";
import RolesTab from "../RolesTab.svelte";

const K1 = "employee:read:EIGENE";
const K2 = "employee:read:ZUGEWIESEN";
const K3 = "role:read:ZUGEWIESEN";
const FOUR_EYES_MSG =
  "Diese Zusammenstellung erlaubt es, eigene Zeiten zu ändern und Zeiten zu genehmigen.";

const CATALOG = [
  {
    resource: "employee",
    label: "Gruppe Personen",
    permissions: [
      { key: K1, label: "Testbeschriftung Eins", reach: "EIGENE", relation: "PERSON" },
      { key: K2, label: "Testbeschriftung Zwei", reach: "ZUGEWIESEN", relation: "PERSON" },
    ],
  },
  {
    resource: "role",
    label: "Gruppe Mandant",
    permissions: [
      { key: K3, label: "Testbeschriftung Drei", reach: "ZUGEWIESEN", relation: "MANDANT" },
    ],
  },
];

const ADMIN = {
  id: "r-admin",
  name: "Admin",
  permissions: [K1, K2, K3],
  isSystem: true,
  createdAt: "",
  updatedAt: "",
};
const TEAM = {
  id: "r-team",
  name: "Teamleitung",
  permissions: [K2],
  isSystem: false,
  createdAt: "",
  updatedAt: "",
};

let roles: (typeof ADMIN)[] = [];

function fourEyes() {
  return new ApiError(409, FOUR_EYES_MSG, {
    error: FOUR_EYES_MSG,
    code: "FOUR_EYES_CONFIRMATION_REQUIRED",
  });
}

beforeEach(() => {
  apiGet.mockReset();
  apiPost.mockReset();
  apiPatch.mockReset();
  apiDelete.mockReset();
  roles = [ADMIN, TEAM];
  apiGet.mockImplementation((path: string) => {
    if (path === "/roles/permission-catalog") return Promise.resolve(CATALOG);
    if (path === "/roles") return Promise.resolve(roles);
    return Promise.reject(new Error(`unexpected GET ${path}`));
  });
});

async function mount(canManage = true) {
  renderWithTheme(RolesTab, { canManage, draft: null });
  await screen.findByText("Teamleitung");
}

function row(name: string) {
  return screen.getByText(name).closest("tr") as HTMLElement;
}

async function ticked(label: string) {
  await fireEvent.click(screen.getByLabelText(label));
}

describe("RolesTab (Issue #83)", () => {
  it("tracer: a new role is created from catalog labels, keys sent in catalog order", async () => {
    await mount();
    expect(screen.getAllByRole("row").map((r) => r.textContent)).toEqual([
      expect.stringContaining("Rolle"),
      expect.stringContaining("Admin"),
      expect.stringContaining("Teamleitung"),
    ]);
    await fireEvent.click(screen.getByRole("button", { name: "Neue Rolle" }));
    await fireEvent.input(screen.getByLabelText("Name der Rolle"), {
      target: { value: "Probe-Rolle" },
    });
    await ticked("Testbeschriftung Zwei");
    await ticked("Testbeschriftung Eins");
    const created = { ...TEAM, id: "r-new", name: "Probe-Rolle", permissions: [K1, K2] };
    apiPost.mockImplementationOnce(() => {
      roles = [ADMIN, TEAM, created];
      return Promise.resolve(created);
    });
    await fireEvent.click(screen.getByRole("button", { name: "Speichern" }));
    await waitFor(() =>
      expect(apiPost).toHaveBeenCalledWith("/roles", {
        name: "Probe-Rolle",
        permissions: [K1, K2],
      }),
    );
    expect(apiPost).toHaveBeenCalledTimes(1);
    await waitFor(() => expect(row("Probe-Rolle").className).toContain("roles-row-active"));
  });

  it("a system role opens visibly locked: inputs disabled, explanation shown, copy enabled", async () => {
    await mount();
    expect(within(row("Admin")).getByRole("button", { name: "Löschen" })).toBeDisabled();
    expect(within(row("Admin")).getByRole("button", { name: "Kopieren" })).toBeEnabled();
    await fireEvent.click(within(row("Admin")).getByRole("button", { name: "Ansehen" }));
    expect(screen.getByLabelText("Name der Rolle")).toBeDisabled();
    for (const label of [
      "Testbeschriftung Eins",
      "Testbeschriftung Zwei",
      "Testbeschriftung Drei",
    ]) {
      expect(screen.getByLabelText(label)).toBeDisabled();
    }
    expect(screen.getByText(/Systemrollen sind sichtbar, aber gesperrt/)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Speichern" })).toBeDisabled();
  });

  it("without role:manage every write control is present but disabled", async () => {
    await mount(false);
    expect(screen.getByRole("button", { name: "Neue Rolle" })).toBeDisabled();
    for (const button of screen.getAllByRole("button", { name: "Kopieren" })) {
      expect(button).toBeDisabled();
    }
    for (const button of screen.getAllByRole("button", { name: "Löschen" })) {
      expect(button).toBeDisabled();
    }
    await fireEvent.click(within(row("Teamleitung")).getByRole("button", { name: "Ansehen" }));
    expect(screen.getByLabelText("Name der Rolle")).toBeDisabled();
    expect(screen.getByText(/Sie können Rollen ansehen, aber nicht ändern/)).toBeInTheDocument();
  });

  it("copying a system role opens the editable copy; saving it patches the copy", async () => {
    await mount();
    const copy = { ...ADMIN, id: "r-copy", name: "Admin (Kopie)", isSystem: false };
    apiPost.mockImplementationOnce(() => {
      roles = [ADMIN, TEAM, copy];
      return Promise.resolve(copy);
    });
    await fireEvent.click(within(row("Admin")).getByRole("button", { name: "Kopieren" }));
    await waitFor(() => expect(apiPost).toHaveBeenCalledWith("/roles/r-admin/copy", {}));
    await waitFor(() =>
      expect(screen.getByLabelText("Name der Rolle")).toHaveValue("Admin (Kopie)"),
    );
    expect(screen.getByLabelText("Name der Rolle")).toBeEnabled();
    await ticked("Testbeschriftung Drei");
    apiPatch.mockResolvedValueOnce({ ...copy, permissions: [K1, K2] });
    await fireEvent.click(screen.getByRole("button", { name: "Speichern" }));
    await waitFor(() =>
      expect(apiPatch).toHaveBeenCalledWith("/roles/r-copy", {
        name: "Admin (Kopie)",
        permissions: [K1, K2],
      }),
    );
  });

  it("four-eyes on create: confirmation resends with confirm: true", async () => {
    await mount();
    await fireEvent.click(screen.getByRole("button", { name: "Neue Rolle" }));
    await fireEvent.input(screen.getByLabelText("Name der Rolle"), { target: { value: "Probe" } });
    await ticked("Testbeschriftung Eins");
    apiPost.mockRejectedValueOnce(fourEyes());
    apiPost.mockResolvedValueOnce({ ...TEAM, id: "r-p", name: "Probe", permissions: [K1] });
    await fireEvent.click(screen.getByRole("button", { name: "Speichern" }));
    expect(await screen.findByText(FOUR_EYES_MSG)).toBeInTheDocument();
    await fireEvent.click(screen.getByRole("button", { name: "Zusammenstellung bestätigen" }));
    await waitFor(() => expect(apiPost).toHaveBeenCalledTimes(2));
    expect(apiPost.mock.calls[1]).toEqual([
      "/roles",
      { name: "Probe", permissions: [K1], confirm: true },
    ]);
  });

  it("four-eyes cancelled: no second request, the draft stays dirty", async () => {
    await mount();
    await fireEvent.click(screen.getByRole("button", { name: "Neue Rolle" }));
    await fireEvent.input(screen.getByLabelText("Name der Rolle"), { target: { value: "Probe" } });
    apiPost.mockRejectedValueOnce(fourEyes());
    await fireEvent.click(screen.getByRole("button", { name: "Speichern" }));
    await screen.findByText(FOUR_EYES_MSG);
    await fireEvent.click(screen.getByRole("button", { name: "Abbrechen" }));
    expect(apiPost).toHaveBeenCalledTimes(1);
    expect(screen.getByLabelText("Name der Rolle")).toHaveValue("Probe");
    expect(screen.getByText("Nicht gespeichert")).toBeInTheDocument();
  });

  it("four-eyes on copy and on update both resend with confirm: true", async () => {
    await mount();
    const copy = { ...ADMIN, id: "r-copy", name: "Admin (Kopie)", isSystem: false };
    apiPost.mockRejectedValueOnce(fourEyes());
    apiPost.mockImplementationOnce(() => {
      roles = [ADMIN, TEAM, copy];
      return Promise.resolve(copy);
    });
    await fireEvent.click(within(row("Admin")).getByRole("button", { name: "Kopieren" }));
    await fireEvent.click(
      await screen.findByRole("button", { name: "Zusammenstellung bestätigen" }),
    );
    await waitFor(() =>
      expect(apiPost).toHaveBeenLastCalledWith("/roles/r-admin/copy", { confirm: true }),
    );

    await fireEvent.click(within(row("Teamleitung")).getByRole("button", { name: "Bearbeiten" }));
    await ticked("Testbeschriftung Eins");
    apiPatch.mockRejectedValueOnce(fourEyes());
    apiPatch.mockResolvedValueOnce({ ...TEAM, permissions: [K1, K2] });
    await fireEvent.click(screen.getByRole("button", { name: "Speichern" }));
    await fireEvent.click(
      await screen.findByRole("button", { name: "Zusammenstellung bestätigen" }),
    );
    await waitFor(() =>
      expect(apiPatch).toHaveBeenLastCalledWith("/roles/r-team", {
        name: "Teamleitung",
        permissions: [K1, K2],
        confirm: true,
      }),
    );
  });

  it("any other rejection shows the server text and opens no confirmation", async () => {
    await mount();
    await fireEvent.click(screen.getByRole("button", { name: "Neue Rolle" }));
    await fireEvent.input(screen.getByLabelText("Name der Rolle"), {
      target: { value: "Teamleitung" },
    });
    apiPost.mockRejectedValueOnce(
      new ApiError(409, "Eine Rolle mit diesem Namen existiert bereits.", {
        error: "Eine Rolle mit diesem Namen existiert bereits.",
      }),
    );
    await fireEvent.click(screen.getByRole("button", { name: "Speichern" }));
    expect(await screen.findByRole("alert")).toHaveTextContent(
      "Eine Rolle mit diesem Namen existiert bereits.",
    );
    expect(screen.queryByRole("button", { name: "Zusammenstellung bestätigen" })).toBeNull();
  });

  it("delete goes through a confirmation; a rejection is shown, never thrown", async () => {
    await mount();
    await fireEvent.click(within(row("Teamleitung")).getByRole("button", { name: "Löschen" }));
    expect(await screen.findByText(/Die Rolle „Teamleitung“ wird gelöscht/)).toBeInTheDocument();
    const MSG = "Die Rolle ist noch Nutzern zugewiesen und kann nicht gelöscht werden.";
    apiDelete.mockRejectedValueOnce(new ApiError(409, MSG, { error: MSG }));
    const dialog = screen.getByRole("dialog");
    await fireEvent.click(within(dialog).getByRole("button", { name: "Löschen" }));
    expect(await screen.findByRole("alert")).toHaveTextContent(MSG);

    apiDelete.mockResolvedValueOnce(undefined);
    await fireEvent.click(within(row("Teamleitung")).getByRole("button", { name: "Löschen" }));
    roles = [ADMIN];
    await fireEvent.click(
      within(screen.getByRole("dialog")).getByRole("button", { name: "Löschen" }),
    );
    await waitFor(() => expect(apiDelete).toHaveBeenLastCalledWith("/roles/r-team"));
    await waitFor(() => expect(screen.queryByText("Teamleitung")).toBeNull());
  });

  it("only a group with MANDANT permissions carries the tenant-scope chip (D-03)", async () => {
    await mount();
    await fireEvent.click(screen.getByRole("button", { name: "Neue Rolle" }));
    const chips = screen.getAllByText("wirkt nur bei Zuweisung für den ganzen Mandanten");
    expect(chips).toHaveLength(1);
    expect(chips[0].closest("legend")).toHaveTextContent("Gruppe Mandant");
  });

  it("switching away from a dirty draft asks first; „Abbrechen“ keeps it", async () => {
    await mount();
    await fireEvent.click(within(row("Teamleitung")).getByRole("button", { name: "Bearbeiten" }));
    await ticked("Testbeschriftung Eins");
    await fireEvent.click(within(row("Admin")).getByRole("button", { name: "Ansehen" }));
    expect(await screen.findByText("Änderungen verwerfen?")).toBeInTheDocument();
    await fireEvent.click(
      within(screen.getByRole("dialog")).getByRole("button", { name: "Abbrechen" }),
    );
    expect(screen.getByLabelText("Name der Rolle")).toHaveValue("Teamleitung");
    expect(screen.getByLabelText("Testbeschriftung Eins")).toBeChecked();
  });

  it("never shows a raw permission key", async () => {
    await mount();
    await fireEvent.click(screen.getByRole("button", { name: "Neue Rolle" }));
    expect(document.body.textContent ?? "").not.toMatch(/:(EIGENE|ZUGEWIESEN)/);
  });
});

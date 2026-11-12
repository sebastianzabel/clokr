// Issue #854 (plan 854-20) - the Zugang tab of the employee detail, mounted: the three groups follow
// their permissions, the login actions keep their endpoints, anonymise and hard delete keep their
// confirm flows and show the server's text on refusal, and the no-role hint stays outside the
// permission block.
import { beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, screen, waitFor, within } from "@testing-library/svelte";

vi.mock("$stores/auth", () => ({ authStore: { subscribe: () => () => {} } }));

const apiGet = vi.fn();
const apiPost = vi.fn();
const apiPatch = vi.fn();
const apiDelete = vi.fn();
const success = vi.fn();
const error = vi.fn();

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
      get: (...a: unknown[]) => apiGet(...a),
      post: (...a: unknown[]) => apiPost(...a),
      patch: (...a: unknown[]) => apiPatch(...a),
      delete: (...a: unknown[]) => apiDelete(...a),
    },
  };
});
vi.mock("$stores/toast", () => ({
  toasts: { success: (m: string) => success(m), error: (m: string) => error(m), info: vi.fn() },
}));

const listRoleAssignments = vi.fn();
vi.mock("$lib/api/roles", async (importOriginal) => ({
  ...(await importOriginal<typeof import("$lib/api/roles")>()),
  listRoleAssignments: (...a: unknown[]) => listRoleAssignments(...a),
  listAssignablePeople: () => Promise.resolve([]),
  loadAssignmentChoices: () => Promise.resolve({ roles: [], mandantRoleIds: [] }),
}));

import { renderWithTheme } from "$tests/test-utils";
import ZugangTab from "../ZugangTab.svelte";

type Rights = { canManageAccess: boolean; canAssignRoles: boolean; canAnonymize: boolean };
const ALL: Rights = { canManageAccess: true, canAssignRoles: true, canAnonymize: true };
const NONE: Rights = { canManageAccess: false, canAssignRoles: false, canAnonymize: false };

const ACTIVE = { role: "EMPLOYEE" as const, email: "probe@example.invalid", isActive: true };
const INVITED = { role: "EMPLOYEE" as const, email: "probe@example.invalid", isActive: false };

function mount(
  props: Partial<{
    rights: Rights;
    user: { role: "EMPLOYEE" | null; email: string; isActive: boolean } | null;
    invitationStatus: "ACCEPTED" | "PENDING" | "EXPIRED" | "NONE";
  }> = {},
) {
  const onRemoved = vi.fn();
  const view = renderWithTheme(ZugangTab, {
    employee: {
      id: "emp-1",
      userId: "user-1",
      firstName: "Probe",
      lastName: "Eins",
      user: props.user === undefined ? ACTIVE : props.user,
      invitationStatus: props.invitationStatus ?? "ACCEPTED",
    },
    rights: props.rights ?? ALL,
    canReadRoles: true,
    salons: [],
    salonsLoaded: true,
    onRemoved,
  });
  return { ...view, onRemoved };
}

beforeEach(() => {
  vi.clearAllMocks();
  listRoleAssignments.mockResolvedValue([]);
});

describe("ZugangTab - groups by permission", () => {
  it("shows Rollen, Anmeldung and the deletion group with every right", async () => {
    mount();
    expect(screen.getByRole("heading", { name: "Rollen" })).toBeTruthy();
    expect(screen.getByRole("heading", { name: "Anmeldung" })).toBeTruthy();
    expect(
      screen.getByRole("heading", { name: "Beschäftigung beenden und Daten löschen" }),
    ).toBeTruthy();
    await waitFor(() => expect(listRoleAssignments).toHaveBeenCalledWith("user-1"));
  });

  it("without any right: no role request, an explaining note, no login action, no deletion group", () => {
    mount({ rights: NONE });
    expect(listRoleAssignments).not.toHaveBeenCalled();
    expect(screen.getByText(/siehst du nur mit dem Recht, Rollen zuzuweisen/)).toBeTruthy();
    expect(screen.queryByTestId("zugang-deactivate")).toBeNull();
    expect(screen.queryByTestId("zugang-reactivate")).toBeNull();
    expect(
      screen.queryByRole("heading", { name: "Beschäftigung beenden und Daten löschen" }),
    ).toBeNull();
    // the account facts stay readable
    expect(screen.getByText("probe@example.invalid")).toBeTruthy();
  });

  it("the no-role hint shows for a person without a role even without the assign right", () => {
    mount({ rights: NONE, user: { ...ACTIVE, role: null } });
    expect(screen.getByText(/keine Rolle zugewiesen/)).toBeTruthy();
  });
});

describe("ZugangTab - login actions", () => {
  it("resends the invitation of a pending person through its endpoint", async () => {
    apiPost.mockResolvedValue({});
    mount({ user: INVITED, invitationStatus: "PENDING" });
    expect(screen.getByText("Einladung ausstehend")).toBeTruthy();
    await fireEvent.click(screen.getByTestId("zugang-resend-invitation"));
    await waitFor(() =>
      expect(apiPost).toHaveBeenCalledWith("/employees/emp-1/resend-invitation", {}),
    );
    await waitFor(() => expect(success).toHaveBeenCalledWith("Einladung erneut gesendet."));
  });

  it("offers no resend for an active account, and deactivate instead of reactivate", () => {
    mount();
    expect(screen.queryByTestId("zugang-resend-invitation")).toBeNull();
    expect(screen.getByTestId("zugang-deactivate")).toBeTruthy();
    expect(screen.queryByTestId("zugang-reactivate")).toBeNull();
  });

  it("reactivates only after the confirm dialog and refreshes the account part", async () => {
    apiPatch.mockResolvedValue({});
    apiGet.mockResolvedValue({ user: ACTIVE, invitationStatus: "ACCEPTED" });
    mount({ user: INVITED, invitationStatus: "NONE" });
    await fireEvent.click(screen.getByTestId("zugang-reactivate"));
    expect(apiPatch).not.toHaveBeenCalled();
    const dialog = await screen.findByRole("dialog");
    await fireEvent.click(within(dialog).getByRole("button", { name: "Reaktivieren" }));
    await waitFor(() => expect(apiPatch).toHaveBeenCalledWith("/employees/emp-1/reactivate", {}));
    await waitFor(() => expect(apiGet).toHaveBeenCalledWith("/employees/emp-1"));
    await waitFor(() => expect(screen.getByTestId("zugang-deactivate")).toBeTruthy());
  });
});

describe("ZugangTab - anonymise and hard delete", () => {
  it("anonymises only after the confirm dialog and then leaves the detail", async () => {
    apiDelete.mockResolvedValue({});
    const { onRemoved } = mount();
    await fireEvent.click(screen.getByTestId("zugang-anonymize"));
    expect(apiDelete).not.toHaveBeenCalled();
    const dialog = await screen.findByRole("dialog");
    await fireEvent.click(within(dialog).getByRole("button", { name: "Anonymisieren" }));
    await waitFor(() => expect(apiDelete).toHaveBeenCalledWith("/employees/emp-1"));
    await waitFor(() => expect(onRemoved).toHaveBeenCalledTimes(1));
  });

  it("a refused anonymisation toasts the server's text and does not leave", async () => {
    apiDelete.mockRejectedValue(new Error("Monat ist abgeschlossen."));
    const { onRemoved } = mount();
    await fireEvent.click(screen.getByTestId("zugang-anonymize"));
    const dialog = await screen.findByRole("dialog");
    await fireEvent.click(within(dialog).getByRole("button", { name: "Anonymisieren" }));
    await waitFor(() => expect(error).toHaveBeenCalledWith("Monat ist abgeschlossen."));
    expect(onRemoved).not.toHaveBeenCalled();
  });

  it("a hard delete inside the retention period shows the end date and needs the explicit confirmation", async () => {
    const refusal = Object.assign(new Error("Aufbewahrungsfrist nicht abgelaufen."), {
      data: { retentionExpiresAt: "2036-12-31T00:00:00.000Z" },
    });
    apiDelete.mockRejectedValueOnce(refusal);
    const { onRemoved } = mount();
    await fireEvent.click(screen.getByTestId("zugang-hard-delete"));
    const dialog = await screen.findByRole("dialog");
    await fireEvent.click(within(dialog).getByRole("button", { name: "Endgültig löschen" }));
    await waitFor(() => expect(screen.getByText(/läuft ab am 31\.12\.2036/)).toBeTruthy());
    expect(screen.getByText("Aufbewahrungsfrist nicht abgelaufen.")).toBeTruthy();
    expect(onRemoved).not.toHaveBeenCalled();
    // The button stays off until the person confirms that they know the retention period.
    const button = screen.getByTestId("zugang-hard-delete") as HTMLButtonElement;
    await waitFor(() => expect(button.disabled).toBe(true));

    apiDelete.mockResolvedValueOnce({});
    await fireEvent.click(screen.getByLabelText(/Ich kenne die Aufbewahrungsfrist/));
    await waitFor(() => expect(button.disabled).toBe(false));
    await fireEvent.click(button);
    const again = await screen.findByRole("dialog");
    await fireEvent.click(within(again).getByRole("button", { name: "Endgültig löschen" }));
    await waitFor(() =>
      expect(apiDelete).toHaveBeenLastCalledWith("/employees/emp-1/hard-delete", {
        forceDelete: true,
      }),
    );
    await waitFor(() => expect(onRemoved).toHaveBeenCalledTimes(1));
  });
});

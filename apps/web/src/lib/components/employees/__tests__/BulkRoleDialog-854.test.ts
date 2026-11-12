// Issue #854 (D-854-09) - BulkRoleDialog is the AssignmentDialog in draft mode for several persons:
// it names how many persons the choice applies to, hands the chosen role and scope back and writes
// nothing itself (the page previews the persons and posts one assignment per person).
vi.mock("$stores/auth", () => ({ authStore: { subscribe: () => () => {} } }));

const apiPost = vi.fn();
vi.mock("$api/client", () => {
  class ApiError extends Error {
    constructor(
      public status: number,
      message: string,
    ) {
      super(message);
    }
  }
  return { ApiError, api: { get: vi.fn(), post: (...a: unknown[]) => apiPost(...a) } };
});

import { describe, expect, it, vi } from "vitest";
import { fireEvent, screen, within } from "@testing-library/svelte";
import { renderWithTheme } from "$tests/test-utils";
import BulkRoleDialog from "../BulkRoleDialog.svelte";

const ROLE = {
  id: "r-probe",
  name: "Probe-Rolle",
  permissions: ["employee:read:ZUGEWIESEN"],
  isSystem: false,
  createdAt: "",
  updatedAt: "",
};

function mount(onChoose = vi.fn(), personCount = 3) {
  renderWithTheme(BulkRoleDialog, {
    open: true,
    personCount,
    roles: [ROLE],
    mandantRoleIds: [],
    salons: [{ id: "s-1", name: "Salon Nord" }],
    salonsLoaded: true,
    people: [],
    onChoose,
  });
  return onChoose;
}

describe("BulkRoleDialog", () => {
  it("names the number of selected persons and offers the roles and the three scopes", () => {
    mount();
    const dialog = screen.getByRole("dialog");
    expect(within(dialog).getByText("3 ausgewählte Personen")).toBeInTheDocument();
    expect(within(dialog).getByRole("option", { name: "Probe-Rolle" })).toBeInTheDocument();
    for (const name of ["Ganzes Unternehmen", "Ausgewählte Salons", "Ausgewählte Personen"]) {
      expect(within(dialog).getByRole("radio", { name })).toBeInTheDocument();
    }
  });

  it("says „1 ausgewählte Person“ for a single person", () => {
    mount(vi.fn(), 1);
    expect(screen.getByText("1 ausgewählte Person")).toBeInTheDocument();
  });

  it("hands the chosen role and scope back and sends no request", async () => {
    const onChoose = mount();
    const dialog = screen.getByRole("dialog");
    const confirm = within(dialog).getByRole("button", { name: "Übernehmen" });
    expect(confirm).toBeDisabled();
    await fireEvent.change(within(dialog).getByLabelText("Rolle"), {
      target: { value: "r-probe" },
    });
    await fireEvent.click(within(dialog).getByRole("radio", { name: "Ausgewählte Salons" }));
    await fireEvent.click(within(dialog).getByRole("checkbox", { name: "Salon Nord" }));
    await fireEvent.click(confirm);
    expect(onChoose).toHaveBeenCalledWith({
      accessRoleId: "r-probe",
      scope: { type: "SALONS", salonIds: ["s-1"] },
    });
    expect(apiPost).not.toHaveBeenCalled();
  });
});

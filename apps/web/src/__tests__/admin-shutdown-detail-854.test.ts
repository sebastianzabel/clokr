// Issue #854 (plan 854-12) - the Betriebsurlaub detail sub-route, mounted: the period section saves through its
// own SaveBar with the unchanged five-field PATCH, a refused save keeps the edit and shows the server's text, an
// invalid period blocks the request, exceptions are added in a Dialog and removed / the shutdown deleted only
// after a confirmation (T-854-31). `admin-shutdown-detail-save-wiring.test.ts` pins the source; this proves it runs.
import { beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, screen, waitFor, within } from "@testing-library/svelte";

const get = vi.fn();
const patch = vi.fn();
const post = vi.fn();
const del = vi.fn();
const success = vi.fn();
const error = vi.fn();
const gotoMock = vi.fn();

vi.mock("$app/navigation", () => ({
  goto: (...a: unknown[]) => gotoMock(...a),
  afterNavigate: vi.fn(),
  replaceState: vi.fn(),
}));
vi.mock("$app/stores", async () => {
  const { readable } = await import("svelte/store");
  return {
    page: readable({
      url: new URL("http://localhost/verwalten/regeln/betriebsurlaub/s1"),
      params: { id: "s1" },
      state: {},
    }),
  };
});
vi.mock("$api/client", () => ({
  api: {
    get: (...a: unknown[]) => get(...a),
    patch: (...a: unknown[]) => patch(...a),
    post: (...a: unknown[]) => post(...a),
    delete: (...a: unknown[]) => del(...a),
  },
  ApiError: class ApiError extends Error {
    status: number;
    constructor(status: number, message: string) {
      super(message);
      this.status = status;
    }
  },
}));
vi.mock("$stores/toast", () => ({
  toasts: { success: (m: string) => success(m), error: (m: string) => error(m), info: vi.fn() },
}));

import { renderWithTheme } from "$tests/test-utils";
import { ApiError } from "$api/client";
import Page from "../routes/(app)/admin/shutdowns/[id]/+page.svelte";
import type { CompanyShutdown } from "$lib/settings/betriebsurlaub";

const EMPLOYEES = [
  { id: "emp1", firstName: "Test", lastName: "Eins", employeeNumber: "1" },
  { id: "emp2", firstName: "Test", lastName: "Zwei", employeeNumber: "2" },
];

function shutdown(overrides: Partial<CompanyShutdown> = {}): CompanyShutdown {
  return {
    id: "s1",
    name: "Weihnachtsschließung",
    startDate: "2026-12-24T00:00:00.000Z",
    endDate: "2026-12-31T00:00:00.000Z",
    deductsFromVacation: true,
    notes: "Betriebsferien",
    exceptions: [
      {
        id: "e1",
        employeeId: "emp1",
        reason: "Notdienst",
        employee: EMPLOYEES[0],
      },
    ],
    ...overrides,
  };
}

const bar = () => screen.queryByRole("region", { name: "Speicherleiste" });
const sentBody = () => JSON.parse(JSON.stringify(patch.mock.calls[0][1]));

beforeEach(() => {
  vi.clearAllMocks();
  get.mockImplementation((path: string) =>
    Promise.resolve(path.startsWith("/employees") ? { employees: EMPLOYEES } : [shutdown()]),
  );
  patch.mockResolvedValue(shutdown());
  post.mockResolvedValue({});
  del.mockResolvedValue({});
});

async function mount() {
  renderWithTheme(Page, {});
  await screen.findByRole("heading", { level: 1, name: "Weihnachtsschließung" });
}

describe("Betriebsurlaub detail", () => {
  it("shows the shutdown without a page breadcrumb (the path is in the top bar) and no SaveBar yet", async () => {
    await mount();
    expect(screen.queryByRole("navigation", { name: "Breadcrumb" })).toBeNull();
    expect((screen.getByLabelText(/^Startdatum/) as HTMLInputElement).value).toBe("2026-12-24");
    expect((screen.getByLabelText(/^Bezeichnung/) as HTMLInputElement).value).toBe(
      "Weihnachtsschließung",
    );
    expect(bar()).toBeNull();
  });

  it("an unknown id says so", async () => {
    get.mockImplementation((path: string) =>
      Promise.resolve(path.startsWith("/employees") ? [] : [shutdown({ id: "other" })]),
    );
    renderWithTheme(Page, {});
    expect(await screen.findByText("Betriebsurlaub nicht gefunden.")).toBeTruthy();
    expect(bar()).toBeNull();
  });

  it("saving sends exactly the five fields, toasts and clears the SaveBar", async () => {
    await mount();
    await fireEvent.input(screen.getByLabelText(/^Enddatum/), { target: { value: "2027-01-02" } });
    expect(bar()).toBeTruthy();
    await fireEvent.click(screen.getByRole("button", { name: "Betriebsurlaub speichern" }));
    await waitFor(() => expect(patch).toHaveBeenCalledTimes(1));
    expect(patch.mock.calls[0][0]).toBe("/company-shutdowns/s1");
    expect(sentBody()).toEqual({
      name: "Weihnachtsschließung",
      startDate: "2026-12-24",
      endDate: "2027-01-02",
      deductsFromVacation: true,
      notes: "Betriebsferien",
    });
    await waitFor(() => expect(bar()).toBeNull());
    expect(success).toHaveBeenCalledWith("Betriebsurlaub gespeichert.");
  });

  it("an emptied note is sent as an empty note, so it is really cleared", async () => {
    await mount();
    await fireEvent.input(screen.getByLabelText("Notiz"), { target: { value: "" } });
    await fireEvent.click(screen.getByRole("button", { name: "Betriebsurlaub speichern" }));
    await waitFor(() => expect(patch).toHaveBeenCalledTimes(1));
    expect(sentBody().notes).toBe("");
  });

  it("a period running backwards blocks the save and names the field", async () => {
    await mount();
    await fireEvent.input(screen.getByLabelText(/^Enddatum/), { target: { value: "2026-12-01" } });
    expect(
      await screen.findByText("Das Enddatum darf nicht vor dem Startdatum liegen."),
    ).toBeTruthy();
    const save = screen.getByRole("button", {
      name: "Betriebsurlaub speichern",
    }) as HTMLButtonElement;
    expect(save.disabled).toBe(true);
    expect(patch).not.toHaveBeenCalled();
  });

  it("a refusal of the API keeps the edit and shows the server's text", async () => {
    patch.mockRejectedValue(new ApiError(404, "Nicht gefunden"));
    await mount();
    await fireEvent.input(screen.getByLabelText(/^Bezeichnung/), { target: { value: "Neu" } });
    await fireEvent.click(screen.getByRole("button", { name: "Betriebsurlaub speichern" }));
    expect(await screen.findByText("Nicht gefunden")).toBeTruthy();
    expect(bar()).toBeTruthy();
    expect((screen.getByLabelText(/^Bezeichnung/) as HTMLInputElement).value).toBe("Neu");
  });

  it("discarding restores the stored values", async () => {
    await mount();
    await fireEvent.input(screen.getByLabelText(/^Bezeichnung/), { target: { value: "Neu" } });
    await fireEvent.click(screen.getByRole("button", { name: "Verwerfen" }));
    expect((screen.getByLabelText(/^Bezeichnung/) as HTMLInputElement).value).toBe(
      "Weihnachtsschließung",
    );
    expect(bar()).toBeNull();
  });

  it("lists the exceptions and adds one from the dialog with the unchanged payload", async () => {
    await mount();
    const table = screen.getByRole("table", { name: /Ausnahmen/ });
    expect(table.textContent).toContain("Notdienst");
    await fireEvent.click(screen.getByRole("button", { name: "Ausnahme hinzufügen" }));
    const dialog = await screen.findByRole("dialog");
    const select = within(dialog).getByLabelText(/^Mitarbeitende/) as HTMLSelectElement;
    // The person who already is an exception is not offered again.
    expect([...select.options].map((o) => o.value)).toEqual(["", "emp2"]);
    await fireEvent.change(select, { target: { value: "emp2" } });
    await fireEvent.input(within(dialog).getByLabelText("Grund"), { target: { value: "Urlaub" } });
    await fireEvent.click(within(dialog).getByRole("button", { name: "Hinzufügen" }));
    await waitFor(() => expect(post).toHaveBeenCalledTimes(1));
    expect(post.mock.calls[0][0]).toBe("/company-shutdowns/s1/exceptions");
    expect(post.mock.calls[0][1]).toEqual({ employeeId: "emp2", reason: "Urlaub" });
    expect(success).toHaveBeenCalledWith("Ausnahme hinzugefügt.");
  });

  it("removing an exception waits for the confirmation", async () => {
    await mount();
    await fireEvent.click(screen.getByRole("button", { name: "Entfernen" }));
    const dialog = await screen.findByRole("dialog");
    expect(del).not.toHaveBeenCalled();
    await fireEvent.click(within(dialog).getByRole("button", { name: "Entfernen" }));
    await waitFor(() => expect(del).toHaveBeenCalledWith("/company-shutdowns/s1/exceptions/emp1"));
    expect(success).toHaveBeenCalledWith("Ausnahme entfernt.");
  });

  it("deleting waits for the confirmation and then returns to the Betriebsurlaub tab", async () => {
    await mount();
    await fireEvent.click(screen.getByRole("button", { name: "Betriebsurlaub löschen" }));
    const dialog = await screen.findByRole("dialog");
    expect(del).not.toHaveBeenCalled();
    await fireEvent.click(within(dialog).getByRole("button", { name: "Löschen" }));
    await waitFor(() => expect(del).toHaveBeenCalledWith("/company-shutdowns/s1"));
    await waitFor(() =>
      expect(gotoMock).toHaveBeenCalledWith("/verwalten/regeln/abwesenheiten#betriebsurlaub"),
    );
  });
});

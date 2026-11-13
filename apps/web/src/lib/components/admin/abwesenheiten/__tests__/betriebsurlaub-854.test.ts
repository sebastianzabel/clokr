// Issue #854 (plan 12) - the „Betriebsurlaub“ tab of Verwalten › Regeln › Abwesenheiten, mounted: the list loads
// lazily per year, a shutdown is created in a Dialog with the unchanged payload, a delete waits for its
// confirmation, and the tab is offered only under `company-shutdown:manage` (T-854-30, T-854-31). The route page
// cannot be mounted, so these mount tests (plus the pure helpers) are the tab's gate.
import { beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, screen, waitFor, within } from "@testing-library/svelte";

const get = vi.fn();
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
vi.mock("$api/client", () => ({
  api: {
    get: (...a: unknown[]) => get(...a),
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
import { ABWESENHEITEN_TABS, visibleAbwesenheitenTabs } from "$lib/settings/abwesenheiten";
import {
  createShutdownBody,
  dayCount,
  shutdownFormMessage,
  shutdownYears,
  type CompanyShutdown,
} from "$lib/settings/betriebsurlaub";
import BetriebsurlaubPanel from "../BetriebsurlaubPanel.svelte";

const SHUTDOWNS: CompanyShutdown[] = [
  {
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
        reason: null,
        employee: { id: "emp1", firstName: "Test", lastName: "Person", employeeNumber: "1" },
      },
    ],
  },
  {
    id: "s2",
    name: "Brückentag",
    startDate: "2026-05-15T00:00:00.000Z",
    endDate: "2026-05-15T00:00:00.000Z",
    deductsFromVacation: false,
    notes: null,
    exceptions: [],
  },
];

beforeEach(() => {
  vi.clearAllMocks();
  get.mockResolvedValue(SHUTDOWNS);
  post.mockResolvedValue({ id: "new1" });
  del.mockResolvedValue({});
});

describe("pure helpers", () => {
  it("the form needs a name and a period that does not run backwards", () => {
    expect(
      shutdownFormMessage({ name: " ", startDate: "2026-01-01", endDate: "2026-01-02" }),
    ).toMatch(/Pflichtfelder/);
    expect(shutdownFormMessage({ name: "X", startDate: "", endDate: "2026-01-02" })).toMatch(
      /Pflichtfelder/,
    );
    expect(
      shutdownFormMessage({ name: "X", startDate: "2026-02-01", endDate: "2026-01-02" }),
    ).toMatch(/vor dem Enddatum/);
    expect(
      shutdownFormMessage({ name: "X", startDate: "2026-01-02", endDate: "2026-01-02" }),
    ).toBeNull();
  });

  it("the create body trims the name and omits an empty note", () => {
    expect(
      createShutdownBody({
        name: " Sommer ",
        startDate: "2026-08-01",
        endDate: "2026-08-14",
        deductsFromVacation: false,
        notes: "",
      }),
    ).toEqual({
      name: "Sommer",
      startDate: "2026-08-01",
      endDate: "2026-08-14",
      deductsFromVacation: false,
      notes: undefined,
    });
  });

  it("counts both ends of the period and offers last year to two years ahead", () => {
    expect(dayCount("2026-12-24T00:00:00.000Z", "2026-12-31T00:00:00.000Z")).toBe(8);
    expect(shutdownYears(2026)).toEqual(["2025", "2026", "2027", "2028"]);
  });
});

describe("tab gating (T-854-30)", () => {
  const tabsOf = (permissions: string[]) =>
    visibleAbwesenheitenTabs({ permissions }).map((tab) => tab.value);

  it("the Betriebsurlaub tab needs company-shutdown:manage and nothing else opens it", () => {
    expect(tabsOf(["company-shutdown:manage:ZUGEWIESEN"])).toEqual(["betriebsurlaub"]);
    expect(tabsOf(["leave-config:manage:ZUGEWIESEN"])).toEqual([
      "urlaub",
      "sonderurlaub",
      "uebertrag",
    ]);
    expect(tabsOf(["tenant-settings:update:ZUGEWIESEN"])).not.toContain("betriebsurlaub");
    expect(tabsOf([])).toEqual([]);
  });

  it("a holder of both sees all four tabs in strip order", () => {
    expect(
      tabsOf(["leave-config:manage:ZUGEWIESEN", "company-shutdown:manage:ZUGEWIESEN"]),
    ).toEqual(["urlaub", "sonderurlaub", "uebertrag", "betriebsurlaub"]);
  });

  it("only the settings tabs read the tenant config", () => {
    expect(ABWESENHEITEN_TABS.filter((tab) => tab.usesConfig).map((tab) => tab.value)).toEqual([
      "urlaub",
      "uebertrag",
    ]);
  });
});

describe("BetriebsurlaubPanel", () => {
  it("loads nothing while the tab is not shown", () => {
    renderWithTheme(BetriebsurlaubPanel, { active: false });
    expect(get).not.toHaveBeenCalled();
  });

  it("lists the shutdowns of the year with period, deduction and exceptions", async () => {
    renderWithTheme(BetriebsurlaubPanel, { active: true });
    const table = await screen.findByRole("table", { name: /Betriebsurlaub \d{4}/ });
    expect(get).toHaveBeenCalledWith(`/company-shutdowns?year=${new Date().getFullYear()}`);
    expect(table.textContent).toContain("Weihnachtsschließung");
    expect(table.textContent).toContain("8 Tage");
    expect(table.textContent).toContain("Zieht vom Urlaubskonto ab");
    expect(table.textContent).toContain("Kein Urlaubsabzug");
    expect(table.textContent).toContain("1 Ausnahme");
    expect(table.textContent).toContain("1 Tag");
    expect(table.textContent).not.toContain("1 Tage");
  });

  it("reloads for another year", async () => {
    renderWithTheme(BetriebsurlaubPanel, { active: true });
    await screen.findByRole("table", { name: /Betriebsurlaub/ });
    const next = String(new Date().getFullYear() + 1);
    await fireEvent.change(screen.getByLabelText("Jahr"), { target: { value: next } });
    await waitFor(() => expect(get).toHaveBeenLastCalledWith(`/company-shutdowns?year=${next}`));
  });

  it("says so when loading fails and offers a retry", async () => {
    get.mockRejectedValueOnce(new Error("down"));
    renderWithTheme(BetriebsurlaubPanel, { active: true });
    await screen.findByText(/konnte nicht geladen werden/);
    await fireEvent.click(screen.getByRole("button", { name: "Erneut versuchen" }));
    await screen.findByRole("table", { name: /Betriebsurlaub/ });
  });

  it("an empty year shows the empty state with a create action", async () => {
    get.mockResolvedValue([]);
    renderWithTheme(BetriebsurlaubPanel, { active: true });
    expect(await screen.findByText("Keine Betriebsurlaube")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Ersten Betriebsurlaub anlegen" })).toBeTruthy();
  });

  it("a row opens the detail sub-route", async () => {
    renderWithTheme(BetriebsurlaubPanel, { active: true });
    await fireEvent.click(await screen.findByRole("button", { name: /^Weihnachtsschließung/ }));
    expect(gotoMock).toHaveBeenCalledWith("/verwalten/regeln/betriebsurlaub/s1");
  });

  async function fillCreate() {
    renderWithTheme(BetriebsurlaubPanel, { active: true });
    await screen.findByRole("table", { name: /Betriebsurlaub/ });
    await fireEvent.click(screen.getByRole("button", { name: "Betriebsurlaub anlegen" }));
    return await screen.findByRole("dialog");
  }

  it("creates from the dialog with the unchanged payload and opens the detail", async () => {
    const dialog = await fillCreate();
    await fireEvent.input(within(dialog).getByLabelText(/^Bezeichnung/), {
      target: { value: " Sommer " },
    });
    await fireEvent.input(within(dialog).getByLabelText(/^Startdatum/), {
      target: { value: "2026-08-03" },
    });
    await fireEvent.input(within(dialog).getByLabelText(/^Enddatum/), {
      target: { value: "2026-08-14" },
    });
    await fireEvent.click(within(dialog).getByLabelText("Vom Urlaubskonto abziehen"));
    await fireEvent.click(within(dialog).getByRole("button", { name: "Anlegen" }));
    await waitFor(() => expect(post).toHaveBeenCalledTimes(1));
    expect(post.mock.calls[0][0]).toBe("/company-shutdowns");
    expect(JSON.parse(JSON.stringify(post.mock.calls[0][1]))).toEqual({
      name: "Sommer",
      startDate: "2026-08-03",
      endDate: "2026-08-14",
      deductsFromVacation: false,
    });
    await waitFor(() =>
      expect(gotoMock).toHaveBeenCalledWith("/verwalten/regeln/betriebsurlaub/new1"),
    );
    expect(success).toHaveBeenCalledWith("Betriebsurlaub angelegt.");
  });

  it("an incomplete or backwards period sends nothing", async () => {
    const dialog = await fillCreate();
    await fireEvent.click(within(dialog).getByRole("button", { name: "Anlegen" }));
    expect(await within(dialog).findByText(/Pflichtfelder/)).toBeTruthy();
    await fireEvent.input(within(dialog).getByLabelText(/^Bezeichnung/), {
      target: { value: "X" },
    });
    await fireEvent.input(within(dialog).getByLabelText(/^Startdatum/), {
      target: { value: "2026-08-14" },
    });
    await fireEvent.input(within(dialog).getByLabelText(/^Enddatum/), {
      target: { value: "2026-08-03" },
    });
    await fireEvent.click(within(dialog).getByRole("button", { name: "Anlegen" }));
    expect(await within(dialog).findByText(/vor dem Enddatum/)).toBeTruthy();
    expect(post).not.toHaveBeenCalled();
  });

  it("a refusal of the API stays in the dialog with the server's text", async () => {
    post.mockRejectedValue(new ApiError(403, "Der Monat ist abgeschlossen."));
    const dialog = await fillCreate();
    await fireEvent.input(within(dialog).getByLabelText(/^Bezeichnung/), {
      target: { value: "X" },
    });
    await fireEvent.input(within(dialog).getByLabelText(/^Startdatum/), {
      target: { value: "2026-08-03" },
    });
    await fireEvent.input(within(dialog).getByLabelText(/^Enddatum/), {
      target: { value: "2026-08-04" },
    });
    await fireEvent.click(within(dialog).getByRole("button", { name: "Anlegen" }));
    expect(await within(dialog).findByText("Der Monat ist abgeschlossen.")).toBeTruthy();
    expect(gotoMock).not.toHaveBeenCalled();
    expect(error).not.toHaveBeenCalled();
  });

  it("deleting waits for the confirmation (T-854-31) and then reloads", async () => {
    renderWithTheme(BetriebsurlaubPanel, { active: true });
    await screen.findByRole("table", { name: /Betriebsurlaub/ });
    const row = screen.getByText("Brückentag").closest("tr") as HTMLElement;
    await fireEvent.click(within(row).getByRole("button", { name: "Löschen" }));
    const dialog = await screen.findByRole("dialog");
    expect(del).not.toHaveBeenCalled();
    expect(gotoMock).not.toHaveBeenCalled();
    await fireEvent.click(within(dialog).getByRole("button", { name: "Löschen" }));
    await waitFor(() => expect(del).toHaveBeenCalledWith("/company-shutdowns/s2"));
    await waitFor(() => expect(get).toHaveBeenCalledTimes(2));
    expect(success).toHaveBeenCalledWith("Betriebsurlaub gelöscht.");
  });

  it("cancelling the confirmation deletes nothing", async () => {
    renderWithTheme(BetriebsurlaubPanel, { active: true });
    await screen.findByRole("table", { name: /Betriebsurlaub/ });
    const row = screen.getByText("Brückentag").closest("tr") as HTMLElement;
    await fireEvent.click(within(row).getByRole("button", { name: "Löschen" }));
    const dialog = await screen.findByRole("dialog");
    await fireEvent.click(within(dialog).getByRole("button", { name: "Abbrechen" }));
    expect(del).not.toHaveBeenCalled();
  });
});

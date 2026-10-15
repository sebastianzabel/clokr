// Issue #93 (D-05(1), D-13) - the employee list of the support area, mounted: one row per person with
// the curated columns, a status badge with text, the links into the month and contracts views, the
// stored (anonymised) values of a deleted person and the empty sentence.
import { afterEach, describe, expect, it } from "vitest";

import { renderWithTheme } from "$tests/test-utils";
import type { SupportEmployee } from "$lib/operator/types";
import SupportEmployeeTable from "../SupportEmployeeTable.svelte";

function byId(id: string): HTMLElement | null {
  return document.querySelector<HTMLElement>(`[data-testid="${id}"]`);
}

function el(id: string): HTMLElement {
  const found = byId(id);
  if (!found) throw new Error(`missing test id ${id}`);
  return found;
}

function employee(overrides: Partial<SupportEmployee> & { id: string }): SupportEmployee {
  return {
    employeeNumber: "1001",
    firstName: "Vorname",
    lastName: "Nachname",
    hireDate: "2024-03-01",
    exitDate: null,
    status: "ACTIVE",
    homeSalon: { id: "salon-1", name: "Hauptsalon" },
    scheduleType: "FIXED_SCHEDULE",
    ...overrides,
  };
}

const ROWS: SupportEmployee[] = [
  employee({ id: "emp-1" }),
  employee({
    id: "emp-2",
    employeeNumber: "1002",
    status: "EXITED",
    exitDate: "2026-06-30",
    homeSalon: null,
    scheduleType: "SHIFT_BASED",
  }),
  employee({
    id: "emp-3",
    employeeNumber: "GELÖSCHT-003",
    firstName: "Gelöscht",
    lastName: "GELÖSCHT-003",
    status: "ANONYMIZED",
    scheduleType: null,
  }),
  employee({ id: "emp-4", scheduleType: "SOMETHING_NEW" }),
];

function mount(items: SupportEmployee[] = ROWS) {
  renderWithTheme(SupportEmployeeTable, { tenantId: "tenant-1", employees: items }, "nacht");
}

afterEach(() => {
  document.body.innerHTML = "";
});

describe("SupportEmployeeTable", () => {
  it("renders one row per employee with the curated columns", () => {
    mount();
    const rows = document.querySelectorAll('[data-testid^="op-support-employee-row-"]');
    expect(rows).toHaveLength(4);

    const first = el("op-support-employee-row-emp-1");
    expect(first).toHaveTextContent("1001");
    expect(first).toHaveTextContent("Nachname, Vorname");
    expect(first).toHaveTextContent("Hauptsalon");
    expect(first).toHaveTextContent("Feste Arbeitszeiten");
    expect(first).toHaveTextContent("01.03.2024");

    const exited = el("op-support-employee-row-emp-2");
    expect(exited).toHaveTextContent("Schichtbasiert");
    expect(exited).toHaveTextContent("30.06.2026");
  });

  it("has the column headings of the contract of the view", () => {
    mount();
    const headings = Array.from(el("op-support-employees").querySelectorAll("th")).map((th) =>
      th.textContent?.trim(),
    );
    expect(headings).toEqual([
      "Personalnummer",
      "Name",
      "Status",
      "Stammsalon",
      "Vertragsart",
      "Eintritt",
      "Austritt",
      "Ansichten",
    ]);
  });

  it("shows the status as a badge with text, keyed by the control value", () => {
    mount();
    expect(el("op-support-employee-status-emp-1")).toHaveTextContent("Aktiv");
    expect(el("op-support-employee-status-emp-1")).toHaveAttribute("data-state", "ACTIVE");
    expect(el("op-support-employee-status-emp-2")).toHaveTextContent("Ausgetreten");
    expect(el("op-support-employee-status-emp-2")).toHaveAttribute("data-state", "EXITED");
    expect(el("op-support-employee-status-emp-3")).toHaveTextContent("Gelöscht");
    expect(el("op-support-employee-status-emp-3")).toHaveAttribute("data-state", "ANONYMIZED");
  });

  it("lists an anonymised person with the stored values", () => {
    mount();
    const row = el("op-support-employee-row-emp-3");
    expect(row).toHaveTextContent("GELÖSCHT-003");
    expect(row).toHaveTextContent("GELÖSCHT-003, Gelöscht");
  });

  it("shows a dash for a missing home salon, exit date or contract type, and raw for an unknown type", () => {
    mount();
    const noSalon = el("op-support-employee-row-emp-2");
    expect(noSalon.querySelector('[data-label="Stammsalon"]')).toHaveTextContent("–");
    const noContract = el("op-support-employee-row-emp-3");
    expect(noContract.querySelector('[data-label="Vertragsart"]')).toHaveTextContent("–");
    expect(
      el("op-support-employee-row-emp-1").querySelector('[data-label="Austritt"]'),
    ).toHaveTextContent("–");
    expect(el("op-support-employee-row-emp-4")).toHaveTextContent("SOMETHING_NEW");
  });

  it("links every row to the month view and the contracts view", () => {
    mount();
    expect(el("op-support-employee-month-emp-1")).toHaveAttribute(
      "href",
      "/betreiber/mandanten/tenant-1/support/mitarbeitende/emp-1",
    );
    expect(el("op-support-employee-contracts-emp-1")).toHaveAttribute(
      "href",
      "/betreiber/mandanten/tenant-1/support/mitarbeitende/emp-1/vertraege",
    );
    expect(el("op-support-employee-month-emp-1")).toHaveTextContent("Monatsansicht");
    expect(el("op-support-employee-contracts-emp-1")).toHaveTextContent("Verträge");
  });

  it("names the person in the accessible name of both links", () => {
    mount();
    expect(el("op-support-employee-month-emp-1")).toHaveAttribute(
      "aria-label",
      "Monatsansicht von Vorname Nachname",
    );
    expect(el("op-support-employee-contracts-emp-1")).toHaveAttribute(
      "aria-label",
      "Verträge von Vorname Nachname",
    );
  });

  it("says so when the list is empty", () => {
    mount([]);
    expect(el("op-support-employees-empty")).toHaveTextContent("Keine Mitarbeitenden gefunden.");
    expect(byId("op-support-employees")).toBeNull();
  });
});

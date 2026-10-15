// Issue #93 (D-05(3), AC-93-9) - the contract history of one employee, mounted: one card per contract
// in the order the API sends (newest first), the schedule columns in German, the weekday lists Mo to So,
// and the note that the day hours bind only a fixed schedule (CLAUDE.md "Schedule Types") - shown, never
// corrected. An unknown code is shown raw, an empty history says so.
import { afterEach, describe, expect, it } from "vitest";

import { renderWithTheme } from "$tests/test-utils";
import type { SupportContract } from "$lib/operator/types";
import SupportContracts from "../SupportContracts.svelte";

function byId(id: string): HTMLElement | null {
  return document.querySelector<HTMLElement>(`[data-testid="${id}"]`);
}

function el(id: string): HTMLElement {
  const found = byId(id);
  if (!found) throw new Error(`missing test id ${id}`);
  return found;
}

const NOTE = "Tagesstunden sind nur bei festen Arbeitszeiten verbindlich.";

function contract(overrides: Partial<SupportContract> & { id: string }): SupportContract {
  return {
    type: "FIXED_SCHEDULE",
    validFrom: "2026-09-01T00:00:00.000Z",
    weeklyHours: 40,
    monthlyHours: null,
    dayHours: {
      monday: 8,
      tuesday: 8,
      wednesday: 8,
      thursday: 8,
      friday: 8,
      saturday: 0,
      sunday: 0,
    },
    workDays: [1, 2, 3, 4, 5],
    contractWorkDaysPerWeek: null,
    usualWorkDays: [],
    overtimeMode: "CARRY_FORWARD",
    overtimeThreshold: 60,
    allowOvertimePayout: false,
    maxNegativeBalanceMinutes: null,
    coreStart: null,
    coreEnd: null,
    coreDays: [],
    ...overrides,
  };
}

const SHIFT = contract({
  id: "c-shift",
  type: "SHIFT_BASED",
  validFrom: "2026-03-01T00:00:00.000Z",
  weeklyHours: 30,
  dayHours: {
    monday: 1,
    tuesday: 1,
    wednesday: 1,
    thursday: 1,
    friday: 1,
    saturday: 1,
    sunday: 0,
  },
  workDays: [0, 1, 3],
  contractWorkDaysPerWeek: 4,
  usualWorkDays: [2, 4, 6],
  overtimeMode: "TRACK_ONLY",
  allowOvertimePayout: true,
  maxNegativeBalanceMinutes: 600,
});

const FIXED = contract({ id: "c-fixed" });

function mount(items: SupportContract[]) {
  renderWithTheme(SupportContracts, { contracts: items }, "nacht");
}

afterEach(() => {
  document.body.innerHTML = "";
});

describe("SupportContracts", () => {
  it("renders one card per contract in the order the API sends", () => {
    mount([FIXED, SHIFT]);
    const rows = Array.from(
      document.querySelectorAll<HTMLElement>('[data-testid^="op-support-contract-row-"]'),
    ).map((row) => row.dataset.testid);
    expect(rows).toEqual(["op-support-contract-row-c-fixed", "op-support-contract-row-c-shift"]);
    expect(el("op-support-contracts")).toBeInTheDocument();
  });

  it("shows the day-hours note on the shift-based contract only", () => {
    mount([FIXED, SHIFT]);
    expect(byId("op-support-contract-dayhours-note-c-fixed")).toBeNull();
    expect(el("op-support-contract-dayhours-note-c-shift")).toHaveTextContent(NOTE);
    expect(el("op-support-contract-row-c-fixed")).not.toHaveTextContent(NOTE);
  });

  it("shows the note for every contract type but the fixed schedule, an unknown one included", () => {
    mount([
      contract({ id: "c-flex", type: "FLEXTIME" }),
      contract({ id: "c-month", type: "MONTHLY_HOURS", monthlyHours: 40, weeklyHours: null }),
      contract({ id: "c-new", type: "SOMETHING_NEW" }),
    ]);
    for (const id of ["c-flex", "c-month", "c-new"]) {
      expect(el(`op-support-contract-dayhours-note-${id}`)).toHaveTextContent(NOTE);
    }
  });

  it("renders the columns of a fixed schedule in German", () => {
    mount([FIXED]);
    const row = el("op-support-contract-row-c-fixed");
    expect(row).toHaveTextContent("Feste Arbeitszeiten");
    expect(row).toHaveTextContent("01.09.2026");
    expect(row).toHaveTextContent("Wochenstunden");
    expect(row).toHaveTextContent("40");
    expect(row).toHaveTextContent("Mo, Di, Mi, Do, Fr");
    expect(row).toHaveTextContent("Überstunden übertragen");
    expect(row).toHaveTextContent("Mandanten-Standard");
    // The seven day columns, Monday to Sunday, with the stored values.
    const cells = Array.from(row.querySelectorAll("table tbody td")).map((td) => td.textContent);
    expect(cells?.map((text) => text?.trim())).toEqual(["8", "8", "8", "8", "8", "0", "0"]);
    const heads = Array.from(row.querySelectorAll("table thead th")).map((th) => th.textContent);
    expect(heads?.map((text) => text?.trim())).toEqual(["Mo", "Di", "Mi", "Do", "Fr", "Sa", "So"]);
  });

  it("renders the shift-based columns and keeps the stored day hours as they are", () => {
    mount([SHIFT]);
    const row = el("op-support-contract-row-c-shift");
    expect(row).toHaveTextContent("Schichtbasiert");
    expect(row).toHaveTextContent("Mo, Mi, So");
    expect(row).toHaveTextContent("Di, Do, Sa");
    expect(row).toHaveTextContent("Vertragstage je Woche");
    expect(row).toHaveTextContent("Nur erfassen");
    expect(row).toHaveTextContent("Auszahlung");
    expect(row).toHaveTextContent("Ja");
    expect(row).toHaveTextContent("10:00");
    const cells = Array.from(row.querySelectorAll("table tbody td")).map((td) =>
      td.textContent?.trim(),
    );
    expect(cells).toEqual(["1", "1", "1", "1", "1", "1", "0"]);
  });

  it("says when no usual workdays or no core time are stored", () => {
    mount([FIXED]);
    const row = el("op-support-contract-row-c-fixed");
    expect(row).toHaveTextContent("Übliche Arbeitstage");
    expect(row).toHaveTextContent("keine Angabe");
    expect(row).toHaveTextContent("Kernzeit");
  });

  it("renders a core time with its days", () => {
    mount([
      contract({
        id: "c-core",
        type: "FLEXTIME",
        coreStart: "09:00",
        coreEnd: "15:00",
        coreDays: [1, 2, 3],
      }),
    ]);
    expect(el("op-support-contract-row-c-core")).toHaveTextContent("09:00 – 15:00 (Mo, Di, Mi)");
  });

  it("shows an unknown code and an unknown weekday raw", () => {
    mount([
      contract({
        id: "c-odd",
        type: "SOMETHING_NEW",
        overtimeMode: "MYSTERY_MODE",
        workDays: [9, 1],
      }),
    ]);
    const row = el("op-support-contract-row-c-odd");
    expect(row).toHaveTextContent("SOMETHING_NEW");
    expect(row).toHaveTextContent("MYSTERY_MODE");
    expect(row).toHaveTextContent("Mo, 9");
  });

  it("renders a markup-looking code as text", () => {
    mount([contract({ id: "c-xss", type: "<img src=x>" })]);
    expect(el("op-support-contract-row-c-xss")).toHaveTextContent("<img src=x>");
    expect(document.querySelector("img")).toBeNull();
  });

  it("says when no contract is stored", () => {
    mount([]);
    expect(el("op-support-contracts")).toHaveTextContent("Keine Verträge hinterlegt.");
    expect(document.querySelectorAll('[data-testid^="op-support-contract-row-"]')).toHaveLength(0);
  });
});

// Issue #93 (D-05(2), AC-93-9) - the month view of one employee, mounted: figures with their closed
// state, the entries with breaks and the markers (ungültig with the label of its code, gelöscht,
// gesperrt), the day breaks, the leave requests and the absences. Labels are keyed by codes, an
// unknown code is shown raw, every empty section says so.
import { afterEach, describe, expect, it } from "vitest";

import { renderWithTheme } from "$tests/test-utils";
import type { SupportEmployeeMonth, SupportMonthEntry } from "$lib/operator/types";
import SupportMonthView from "../SupportMonthView.svelte";

function byId(id: string): HTMLElement | null {
  return document.querySelector<HTMLElement>(`[data-testid="${id}"]`);
}

function el(id: string): HTMLElement {
  const found = byId(id);
  if (!found) throw new Error(`missing test id ${id}`);
  return found;
}

function entry(overrides: Partial<SupportMonthEntry> & { id: string }): SupportMonthEntry {
  return {
    date: "2026-09-02",
    startTime: "2026-09-02T07:00:00.000Z",
    endTime: "2026-09-02T15:30:00.000Z",
    breakMinutes: 30,
    breaks: [{ startTime: "2026-09-02T10:00:00.000Z", endTime: "2026-09-02T10:30:00.000Z" }],
    breakStatus: "CONFIRMED",
    salon: { id: "salon-1", name: "Hauptsalon" },
    type: "WORK",
    source: "NFC",
    isInvalid: false,
    invalidReasonCode: null,
    deleted: false,
    isLocked: false,
    ...overrides,
  };
}

function month(overrides: Partial<SupportEmployeeMonth> = {}): SupportEmployeeMonth {
  return {
    employee: {
      id: "emp-1",
      employeeNumber: "1001",
      firstName: "Vorname",
      lastName: "Nachname",
      status: "ACTIVE",
    },
    month: "2026-09",
    timezone: "Europe/Berlin",
    entries: [entry({ id: "e-ok" })],
    dayBreaks: [],
    leaveRequests: [],
    absences: [],
    figures: {
      workedMinutes: 2430,
      expectedMinutes: 2400,
      balanceMinutes: 30,
      balanceAdjustmentMinutes: 0,
      basis: "snapshot",
    },
    figuresUnavailableReason: null,
    snapshot: { confirmed: true, basis: "snapshot" },
    ...overrides,
  };
}

function mount(value: SupportEmployeeMonth) {
  renderWithTheme(SupportMonthView, { month: value }, "nacht");
}

afterEach(() => {
  document.body.innerHTML = "";
});

describe("SupportMonthView header", () => {
  it("names the person, the Personalnummer and the status", () => {
    mount(month());
    const root = el("op-support-month");
    expect(root).toHaveTextContent("Nachname, Vorname");
    expect(root).toHaveTextContent("1001");
    expect(el("op-support-month-status")).toHaveTextContent("Aktiv");
    expect(el("op-support-month-status")).toHaveAttribute("data-state", "ACTIVE");
  });

  it("shows the stored values of an anonymised person with the status Gelöscht", () => {
    mount(
      month({
        employee: {
          id: "emp-9",
          employeeNumber: "GELÖSCHT-009",
          firstName: "Gelöscht",
          lastName: "GELÖSCHT-009",
          status: "ANONYMIZED",
        },
      }),
    );
    expect(el("op-support-month")).toHaveTextContent("GELÖSCHT-009, Gelöscht");
    expect(el("op-support-month-status")).toHaveTextContent("Gelöscht");
  });
});

describe("SupportMonthView figures", () => {
  it("shows Soll, Ist and a signed Saldo as h:mm, the basis and a closed month", () => {
    mount(month());
    const figures = el("op-support-figures");
    expect(el("op-support-figure-expected")).toHaveTextContent("40:00");
    expect(el("op-support-figure-worked")).toHaveTextContent("40:30");
    expect(el("op-support-figure-balance")).toHaveTextContent("+0:30");
    expect(figures).toHaveTextContent("Monat abgeschlossen");
    expect(figures).toHaveTextContent("Abgeschlossen");
  });

  it("marks an open month and a negative Saldo", () => {
    mount(
      month({
        figures: {
          workedMinutes: 1000,
          expectedMinutes: 1100,
          balanceMinutes: -100,
          balanceAdjustmentMinutes: 0,
          basis: "toDate",
        },
        snapshot: { confirmed: false, basis: "toDate" },
      }),
    );
    expect(el("op-support-figures")).toHaveTextContent("Monat offen");
    expect(el("op-support-figures")).toHaveTextContent("Bis heute");
    expect(el("op-support-figure-balance")).toHaveTextContent("−1:40");
  });

  it("says the figures are not available, with the reason label, and shows no number", () => {
    mount(month({ figures: null, snapshot: null, figuresUnavailableReason: "NO_ACTIVE_SALON" }));
    const figures = el("op-support-figures");
    expect(figures).toHaveTextContent("Monatswerte nicht verfügbar");
    expect(figures).toHaveTextContent("Der Mandant hat keinen aktiven Salon.");
    expect(byId("op-support-figure-expected")).toBeNull();
    expect(figures).not.toHaveTextContent("Monat offen");
    expect(figures).not.toHaveTextContent("Monat abgeschlossen");
  });
});

describe("SupportMonthView entries", () => {
  it("renders date, times, breaks, break status, salon, type and source", () => {
    mount(month());
    const row = el("op-support-entry-row-e-ok");
    expect(row).toHaveTextContent("02.09.2026");
    expect(row.textContent).toMatch(/\d{2}:\d{2}/);
    expect(row).toHaveTextContent("30 Min.");
    expect(row).toHaveTextContent("Bestätigt");
    expect(row).toHaveTextContent("Hauptsalon");
    expect(row).toHaveTextContent("Arbeitszeit");
    expect(row).toHaveTextContent("NFC-Terminal");
    expect(row).toHaveAttribute("data-deleted", "false");
    expect(row).toHaveAttribute("data-invalid", "false");
    expect(row).toHaveAttribute("data-locked", "false");
    expect(row.querySelector(".badge")).toBeNull();
  });

  it("lists each break of an entry with its times", () => {
    mount(month());
    const breaks = el("op-support-entry-row-e-ok").querySelectorAll("[data-break]");
    expect(breaks).toHaveLength(1);
    expect(breaks[0].textContent).toMatch(/\d{2}:\d{2}\s*–\s*\d{2}:\d{2}/);
  });

  it("shows legacy break minutes without a position, and a dash without breaks", () => {
    mount(
      month({
        entries: [
          entry({ id: "e-legacy", breaks: [], breakMinutes: 45 }),
          entry({ id: "e-none", breaks: [], breakMinutes: 0 }),
        ],
      }),
    );
    expect(el("op-support-entry-row-e-legacy")).toHaveTextContent("45 Min.");
    expect(
      el("op-support-entry-row-e-none").querySelector('[data-label="Pausen"]'),
    ).toHaveTextContent("–");
  });

  it("shows an open entry as offen", () => {
    mount(
      month({ entries: [entry({ id: "e-open", endTime: null, breaks: [], breakMinutes: 0 })] }),
    );
    expect(el("op-support-entry-row-e-open")).toHaveTextContent("offen");
  });

  it("marks a deleted entry: present, muted, with the badge gelöscht", () => {
    mount(month({ entries: [entry({ id: "e-del", deleted: true })] }));
    const row = el("op-support-entry-row-e-del");
    expect(row).toHaveAttribute("data-deleted", "true");
    expect(row).toHaveTextContent("gelöscht");
    expect(row.className).toContain("deleted");
  });

  it("marks an invalid entry with the label of its reason code", () => {
    mount(
      month({
        entries: [
          entry({ id: "e-inv", isInvalid: true, invalidReasonCode: "MISSING_CLOCK_OUT" }),
          entry({ id: "e-new", isInvalid: true, invalidReasonCode: "SOMETHING_NEW" }),
          entry({ id: "e-nocode", isInvalid: true, invalidReasonCode: null }),
        ],
      }),
    );
    const row = el("op-support-entry-row-e-inv");
    expect(row).toHaveAttribute("data-invalid", "true");
    expect(row).toHaveTextContent("ungültig: Ausstempeln fehlt");
    expect(el("op-support-entry-row-e-new")).toHaveTextContent("ungültig: SOMETHING_NEW");
    expect(el("op-support-entry-row-e-nocode")).toHaveTextContent("ungültig");
    expect(el("op-support-entry-row-e-nocode")).not.toHaveTextContent("ungültig:");
  });

  it("marks a locked entry with the badge gesperrt", () => {
    mount(month({ entries: [entry({ id: "e-lock", isLocked: true })] }));
    const row = el("op-support-entry-row-e-lock");
    expect(row).toHaveAttribute("data-locked", "true");
    expect(row).toHaveTextContent("gesperrt");
  });

  it("shows an unknown type, source and break status raw", () => {
    mount(
      month({
        entries: [
          entry({ id: "e-raw", type: "NEW_TYPE", source: "NEW_SOURCE", breakStatus: "NEW_STATUS" }),
        ],
      }),
    );
    const row = el("op-support-entry-row-e-raw");
    expect(row).toHaveTextContent("NEW_TYPE");
    expect(row).toHaveTextContent("NEW_SOURCE");
    expect(row).toHaveTextContent("NEW_STATUS");
  });

  it("renders a salon name as text, never as markup", () => {
    mount(month({ entries: [entry({ id: "e-x", salon: { id: "s", name: "<b>Salon</b>" } })] }));
    expect(el("op-support-entry-row-e-x").querySelector("b")).toBeNull();
    expect(el("op-support-entry-row-e-x")).toHaveTextContent("<b>Salon</b>");
  });

  it("says so when the month has no entries", () => {
    mount(month({ entries: [] }));
    expect(el("op-support-entries")).toHaveTextContent("Keine Zeiteinträge in diesem Monat.");
    expect(byId("op-support-entries-table")).toBeNull();
  });
});

describe("SupportMonthView day breaks, leave and absences", () => {
  it("lists the day breaks with the day and the times", () => {
    mount(
      month({
        dayBreaks: [
          {
            id: "db-1",
            date: "2026-09-03",
            startTime: "2026-09-03T10:00:00.000Z",
            endTime: "2026-09-03T10:20:00.000Z",
          },
        ],
      }),
    );
    expect(el("op-support-daybreaks")).toHaveTextContent("03.09.2026");
    expect(el("op-support-daybreaks").textContent).toMatch(/\d{2}:\d{2}\s*–\s*\d{2}:\d{2}/);
  });

  it("lists leave requests with the type name, the status label, the period, the half day and the days", () => {
    mount(
      month({
        leaveRequests: [
          {
            id: "lr-1",
            typeCode: "VACATION",
            typeName: "Erholungsurlaub",
            status: "APPROVED",
            startDate: "2026-09-14",
            endDate: "2026-09-18",
            halfDay: false,
            days: 5,
            daysProvisional: true,
          },
          {
            id: "lr-2",
            typeCode: "SICK",
            typeName: "Krank",
            status: "SOMETHING_NEW",
            startDate: "2026-09-21",
            endDate: "2026-09-21",
            halfDay: true,
            days: 0.5,
            daysProvisional: null,
          },
        ],
      }),
    );
    const first = el("op-support-leave-row-lr-1");
    expect(first).toHaveTextContent("Erholungsurlaub");
    expect(first).toHaveTextContent("Genehmigt");
    expect(first).toHaveTextContent("14.09.2026 – 18.09.2026");
    expect(first).toHaveTextContent("5");
    expect(first).toHaveTextContent("vorläufig");
    const second = el("op-support-leave-row-lr-2");
    expect(second).toHaveTextContent("SOMETHING_NEW");
    expect(second).toHaveTextContent("21.09.2026");
    expect(second).not.toHaveTextContent("21.09.2026 –");
    expect(second).toHaveTextContent("halber Tag");
    expect(second).toHaveTextContent("0,5");
    expect(second).not.toHaveTextContent("vorläufig");
  });

  it("lists absences with the type label and the source", () => {
    mount(
      month({
        absences: [
          {
            id: "ab-1",
            type: "VOCATIONAL_SCHOOL",
            source: "PATTERN",
            startDate: "2026-09-07",
            endDate: "2026-09-07",
            halfDay: false,
          },
        ],
      }),
    );
    const row = el("op-support-absence-row-ab-1");
    expect(row).toHaveTextContent("Berufsschule");
    expect(row).toHaveTextContent("Automatisch (Muster)");
    expect(row).toHaveTextContent("07.09.2026");
  });

  it("says so in an empty month for day breaks, leave and absences", () => {
    mount(month());
    expect(el("op-support-daybreaks")).toHaveTextContent("Keine Tagespausen in diesem Monat.");
    expect(el("op-support-leave")).toHaveTextContent("Keine Anträge in diesem Monat.");
    expect(el("op-support-absences")).toHaveTextContent("Keine Abwesenheiten in diesem Monat.");
  });
});

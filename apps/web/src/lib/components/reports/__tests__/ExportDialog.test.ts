// Issue #612 (D-612-6, ADD-5, UI-SPEC "„Exportieren“ dialog") - the one export dialog, mounted. It
// holds Monatsexport (PDF), DATEV-Export and „Tabelle als CSV“; for a multi-month period it asks for
// the month of the first two; the § 9 note sits in the Monatsexport block and follows that month.
// lib/components/reports/ is outside the lint:ui-classes gate (CLAUDE.md), so it is proven here.

import { describe, it, expect, vi } from "vitest";
import { screen, fireEvent, within, waitFor } from "@testing-library/svelte";
import { renderWithTheme } from "$tests/test-utils";
import {
  DATEV_ALL_SALONS_NOTE,
  EXPORT_NO_STAMMSALON_NOTE,
  PERSON_SALDO_NOT_SPLIT_LABEL,
  SALON_CSV_PERSONS_NOTE,
  SALON_EXPORT_PERSONS_NOTE,
  SALON_VIEW_UNAVAILABLE_TEXT,
} from "$lib/salons/page-scope";
import ExportDialog from "../ExportDialog.svelte";
import source from "../ExportDialog.svelte?raw";

// The page-scope module reaches the api client and its auth store (localStorage bootstrap); a
// stand-in keeps this mounted test free of it (as in page-scope.test.ts).
vi.mock("$api/client", () => ({
  api: { get: vi.fn() },
  ApiError: class ApiError extends Error {
    constructor(
      public status: number,
      message = "err",
    ) {
      super(message);
    }
  },
}));
vi.mock("$lib/utils/logger", () => ({ clientLogger: { warn: vi.fn(), error: vi.fn() } }));

function props(overrides: Record<string, unknown> = {}) {
  return {
    open: true,
    from: { year: 2026, month: 9 },
    to: { year: 2026, month: 9 },
    periodLabel: "September 2026",
    filterActive: false,
    salonRejected: false,
    loadSection9Note: vi.fn().mockResolvedValue(null),
    onMonthlyExport: vi.fn().mockResolvedValue(undefined),
    onDatev: vi.fn().mockResolvedValue(undefined),
    onCsv: vi.fn().mockResolvedValue(undefined),
    onError: vi.fn(),
    ...overrides,
  };
}

const MULTI = {
  from: { year: 2026, month: 7 },
  to: { year: 2026, month: 9 },
  periodLabel: "Jul – Sep 2026",
};

// The phrase the HR e2e matches by regex (hr-view-86.spec.ts), spelled in two halves so that
// this directory holds the literal nowhere (the rendered text must not contain it either).
const HR_E2E_PHRASE = ["PDF", "herunterladen"].join(" ");

describe("ExportDialog - one-month period", () => {
  it("titles the dialog with the period as eyebrow", () => {
    renderWithTheme(ExportDialog, props());
    expect(screen.getByRole("dialog", { name: "Exportieren" })).toBeTruthy();
    expect(screen.getByRole("heading", { name: "Exportieren" })).toBeTruthy();
    expect(screen.getByText("September 2026")).toBeTruthy();
  });

  it("has the three blocks with their descriptions and buttons, and no month field", () => {
    renderWithTheme(ExportDialog, props());
    for (const title of ["Monatsexport (PDF)", "DATEV-Export", "Tabelle als CSV"]) {
      expect(screen.getByRole("heading", { name: title })).toBeTruthy();
    }
    expect(
      screen.getByText(
        "Lesbare Fassung des DATEV-Exports – alle Personen eines Monats, ohne Tagesliste.",
      ),
    ).toBeTruthy();
    expect(screen.getByText("Lohndatei für die Übergabe an DATEV, ein Monat.")).toBeTruthy();
    expect(
      screen.getByText(
        "Die Tabelle „Zeiten & Konten“ für den ganzen Zeitraum, Semikolon-getrennt, für Excel.",
      ),
    ).toBeTruthy();
    for (const name of [
      "Monatsexport herunterladen",
      "DATEV-Datei herunterladen",
      "CSV-Datei herunterladen",
    ]) {
      expect(screen.getByRole("button", { name })).toBeTruthy();
    }
    expect(screen.queryByRole("combobox")).toBeNull();
    expect(screen.queryByText("Monatsexport und DATEV gelten für einen Monat.")).toBeNull();
  });

  it("puts the initial focus on the first button when there is no month field", () => {
    renderWithTheme(ExportDialog, props());
    const marked = document.querySelectorAll("[data-autofocus]");
    expect(marked).toHaveLength(1);
    expect(marked[0].textContent).toContain("Monatsexport herunterladen");
  });

  it("calls the three callbacks: Monatsexport and DATEV with the month, the CSV with nothing", async () => {
    const p = props();
    renderWithTheme(ExportDialog, p);
    await fireEvent.click(screen.getByRole("button", { name: "Monatsexport herunterladen" }));
    await fireEvent.click(screen.getByRole("button", { name: "DATEV-Datei herunterladen" }));
    await fireEvent.click(screen.getByRole("button", { name: "CSV-Datei herunterladen" }));
    expect(p.onMonthlyExport).toHaveBeenCalledWith(2026, 9);
    expect(p.onDatev).toHaveBeenCalledWith(2026, 9);
    expect(p.onCsv).toHaveBeenCalledWith();
  });

  it("never renders the phrase the HR e2e matches by regex", () => {
    renderWithTheme(ExportDialog, props());
    expect(document.body.textContent).not.toContain(HR_E2E_PHRASE);
    expect(source).not.toContain(HR_E2E_PHRASE);
  });

  it("renders nothing while closed", () => {
    renderWithTheme(ExportDialog, props({ open: false }));
    expect(screen.queryByRole("dialog")).toBeNull();
  });

  it("closes with Schließen", async () => {
    renderWithTheme(ExportDialog, props());
    await fireEvent.click(screen.getByRole("button", { name: "Schließen" }));
    expect(screen.queryByRole("dialog")).toBeNull();
  });
});

describe("ExportDialog - multi-month period", () => {
  it("asks for the month of Monatsexport and DATEV, defaulting to the last, with the hint", () => {
    renderWithTheme(ExportDialog, props(MULTI));
    const select = screen.getByRole("combobox", {
      name: "Monat für Monatsexport und DATEV",
    }) as HTMLSelectElement;
    expect(
      within(select)
        .getAllByRole("option")
        .map((o) => o.textContent?.trim()),
    ).toEqual(["Juli 2026", "August 2026", "September 2026"]);
    expect(select.value).toBe("2026-09");
    expect(screen.getByText("Monatsexport und DATEV gelten für einen Monat.")).toBeTruthy();
    expect(select.hasAttribute("data-autofocus")).toBe(true);
    expect(document.querySelectorAll("[data-autofocus]")).toHaveLength(1);
  });

  it("the chosen month drives Monatsexport and DATEV, the CSV covers the whole period", async () => {
    const p = props(MULTI);
    renderWithTheme(ExportDialog, p);
    await fireEvent.change(
      screen.getByRole("combobox", { name: "Monat für Monatsexport und DATEV" }),
      {
        target: { value: "2026-07" },
      },
    );
    await fireEvent.click(screen.getByRole("button", { name: "Monatsexport herunterladen" }));
    await fireEvent.click(screen.getByRole("button", { name: "DATEV-Datei herunterladen" }));
    await fireEvent.click(screen.getByRole("button", { name: "CSV-Datei herunterladen" }));
    expect(p.onMonthlyExport).toHaveBeenCalledWith(2026, 7);
    expect(p.onDatev).toHaveBeenCalledWith(2026, 7);
    expect(p.onCsv).toHaveBeenCalledWith();
  });

  it("lists the months of a period across the year change in order", () => {
    renderWithTheme(
      ExportDialog,
      props({
        from: { year: 2025, month: 11 },
        to: { year: 2026, month: 1 },
        periodLabel: "Nov 2025 – Jan 2026",
      }),
    );
    const select = screen.getByRole("combobox", { name: "Monat für Monatsexport und DATEV" });
    expect(
      within(select)
        .getAllByRole("option")
        .map((o) => o.textContent?.trim()),
    ).toEqual(["November 2025", "Dezember 2025", "Januar 2026"]);
  });
});

describe("ExportDialog - the § 9 note", () => {
  it("renders inside the Monatsexport block as a brand callout and follows the chosen month", async () => {
    const loadSection9Note = vi.fn(async (_y: number, m: number) =>
      m === 9 ? "Hinweis September" : m === 7 ? "Hinweis Juli" : null,
    );
    renderWithTheme(ExportDialog, props({ ...MULTI, loadSection9Note }));
    const note = await screen.findByTestId("report-section9-note");
    expect(note.textContent).toContain("Hinweis September");
    expect(note.classList.contains("callout")).toBe(true);
    expect(note.classList.contains("brand")).toBe(true);
    const block = note.closest("[data-export-block]");
    expect(block?.getAttribute("data-export-block")).toBe("monthly");
    expect(loadSection9Note).toHaveBeenCalledWith(2026, 9);
    await fireEvent.change(
      screen.getByRole("combobox", { name: "Monat für Monatsexport und DATEV" }),
      {
        target: { value: "2026-07" },
      },
    );
    await waitFor(() =>
      expect(screen.getByTestId("report-section9-note").textContent).toContain("Hinweis Juli"),
    );
    expect(screen.getAllByTestId("report-section9-note")).toHaveLength(1);
    // The note is shown for August? no - the loader returned null for it
    await fireEvent.change(
      screen.getByRole("combobox", { name: "Monat für Monatsexport und DATEV" }),
      {
        target: { value: "2026-08" },
      },
    );
    await waitFor(() => expect(screen.queryByTestId("report-section9-note")).toBeNull());
  });

  it("shows nothing when the loader has no note, and never while closed", async () => {
    const loadSection9Note = vi.fn().mockResolvedValue(null);
    const { unmount } = renderWithTheme(ExportDialog, props({ loadSection9Note }));
    await waitFor(() => expect(loadSection9Note).toHaveBeenCalled());
    expect(screen.queryByTestId("report-section9-note")).toBeNull();
    unmount();
    const closed = vi.fn().mockResolvedValue("x");
    renderWithTheme(ExportDialog, props({ open: false, loadSection9Note: closed }));
    expect(closed).not.toHaveBeenCalled();
  });

  it("treats a failing loader as no note (the note explains, it never blocks)", async () => {
    const loadSection9Note = vi.fn().mockRejectedValue(new Error("boom"));
    renderWithTheme(ExportDialog, props({ loadSection9Note }));
    await waitFor(() => expect(loadSection9Note).toHaveBeenCalled());
    expect(screen.queryByTestId("report-section9-note")).toBeNull();
    expect(screen.getByRole("button", { name: "Monatsexport herunterladen" })).toBeTruthy();
  });
});

describe("ExportDialog - errors and busy state", () => {
  it.each([
    [
      "Monatsexport herunterladen",
      "onMonthlyExport",
      "Der Monatsexport konnte nicht erstellt werden. Bitte versuchen Sie es erneut.",
    ],
    [
      "DATEV-Datei herunterladen",
      "onDatev",
      "Der DATEV-Export konnte nicht erstellt werden. Bitte versuchen Sie es erneut.",
    ],
    [
      "CSV-Datei herunterladen",
      "onCsv",
      "Die CSV-Datei konnte nicht erstellt werden. Bitte versuchen Sie es erneut.",
    ],
  ])(
    "a rejected %s reports the copy-deck text and keeps the dialog open",
    async (button, cb, text) => {
      const p = props({ [cb]: vi.fn().mockRejectedValue(new Error("boom")) });
      renderWithTheme(ExportDialog, p);
      await fireEvent.click(screen.getByRole("button", { name: button }));
      await waitFor(() => expect(p.onError).toHaveBeenCalledWith(text));
      expect(screen.getByRole("dialog", { name: "Exportieren" })).toBeTruthy();
      expect((screen.getByRole("button", { name: button }) as HTMLButtonElement).disabled).toBe(
        false,
      );
    },
  );

  it("disables only the running button, keeps its label and shows a spinner", async () => {
    let finish!: () => void;
    const onDatev = vi.fn(() => new Promise<void>((resolve) => (finish = resolve)));
    renderWithTheme(ExportDialog, props({ onDatev }));
    await fireEvent.click(screen.getByRole("button", { name: "DATEV-Datei herunterladen" }));
    const running = screen.getByRole("button", {
      name: "DATEV-Datei herunterladen",
    }) as HTMLButtonElement;
    expect(running.disabled).toBe(true);
    expect(within(running).getByRole("status")).toBeTruthy();
    expect(
      (screen.getByRole("button", { name: "CSV-Datei herunterladen" }) as HTMLButtonElement)
        .disabled,
    ).toBe(false);
    finish();
    await waitFor(() => expect(running.disabled).toBe(false));
    expect(within(running).queryByRole("status")).toBeNull();
  });
});

describe("ExportDialog - salon filter (#542)", () => {
  it("shows the person and no-Stammsalon notes in block 1 and the DATEV note in block 2", () => {
    renderWithTheme(ExportDialog, props({ filterActive: true }));
    const monthly = screen.getByTestId("export-salon-persons-note");
    expect(monthly.textContent).toContain(SALON_EXPORT_PERSONS_NOTE);
    expect(monthly.textContent).toContain(PERSON_SALDO_NOT_SPLIT_LABEL);
    expect(monthly.textContent).toContain(EXPORT_NO_STAMMSALON_NOTE);
    expect(monthly.closest("[data-export-block]")?.getAttribute("data-export-block")).toBe(
      "monthly",
    );
    const datev = screen.getByTestId("datev-all-salons-note");
    expect(datev.textContent).toBe(DATEV_ALL_SALONS_NOTE);
    expect(datev.closest("[data-export-block]")?.getAttribute("data-export-block")).toBe("datev");
  });

  // Issue #714 (D-09): the CSV block names whom the file lists under a filter.
  it("names in the CSV block whom the file lists: the Stammsalon at the period end, no helpers (#714)", () => {
    renderWithTheme(ExportDialog, props({ filterActive: true }));
    const csv = screen.getByTestId("export-csv-salon-note");
    expect(csv.textContent).toBe(SALON_CSV_PERSONS_NOTE);
    expect(csv.classList.contains("form-hint")).toBe(true);
    expect(csv.closest("[data-export-block]")?.getAttribute("data-export-block")).toBe("csv");
  });

  it("shows none of the three notes without a filter", () => {
    renderWithTheme(ExportDialog, props());
    expect(screen.queryByTestId("export-salon-persons-note")).toBeNull();
    expect(screen.queryByTestId("datev-all-salons-note")).toBeNull();
    expect(screen.queryByTestId("export-csv-salon-note")).toBeNull();
  });

  it("shows the calm state instead of an error when the salon was rejected", () => {
    renderWithTheme(ExportDialog, props({ filterActive: true, salonRejected: true }));
    expect(screen.getByTestId("salon-scope-unavailable").textContent).toContain(
      SALON_VIEW_UNAVAILABLE_TEXT,
    );
  });

  it("shows no calm state when nothing was rejected", () => {
    renderWithTheme(ExportDialog, props({ filterActive: true }));
    expect(screen.queryByTestId("salon-scope-unavailable")).toBeNull();
  });
});

describe("ExportDialog - source", () => {
  it("[vacuity gate] the source is loaded and imports no $app module", () => {
    expect(source.length).toBeGreaterThan(2000);
    expect(source).not.toMatch(/from "\$app\//);
  });

  it("calls the injected callbacks only; it names no route and no API client", () => {
    for (const route of [
      "/reports/monthly",
      "/reports/datev",
      "/reports/period/csv",
      "/reports/period?",
      "/api/v1",
    ]) {
      expect(source, route).not.toContain(route);
    }
    expect(source).not.toContain("fetch(");
    expect(source).not.toMatch(/from "\$api\//);
  });
});

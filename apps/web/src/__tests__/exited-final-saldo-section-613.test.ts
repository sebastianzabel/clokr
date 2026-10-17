// Issue #613 (AC-613-5) - the exited-persons section of /reports, mounted, plus the source pin of
// the page wiring (the page itself is not mountable: no `$app` alias in vitest.config.ts, same
// technique as reports-resturlaub-columns-451.test.ts).
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, it, expect } from "vitest";
import { screen } from "@testing-library/svelte";
import { renderWithTheme } from "$tests/test-utils";
import ExitedFinalSaldoSection from "$lib/components/reports/ExitedFinalSaldoSection.svelte";
import type { ExitedOverviewRow } from "$lib/reports/overtime-overview-sections";

function row(n: number, exitDate: string | null): ExitedOverviewRow {
  return {
    id: `id-${n}`,
    name: `Person Nr${n}`,
    employeeNumber: `N-${n}`,
    exitDate,
    exitedWithOpenFinalSaldo: true,
    balanceHours: 2,
    confirmedMinutes: 120,
    openMonthMinutes: 0,
    hasClosedMonth: true,
    // Issue #588: three unclosed months -> the column is labelled "Seit Monatsabschluss".
    unconfirmedMonths: 3,
  };
}

describe("ExitedFinalSaldoSection (Issue #613)", () => {
  it("shows the heading with the count, the hint, and per row name, number, exit date and one value per saldo column", () => {
    renderWithTheme(ExitedFinalSaldoSection, {
      rows: [row(1, "2026-10-15"), row(2, "2026-09-30")],
      total: 2,
    });
    expect(
      screen.getByRole("heading", { name: "Ausgetreten, offener Endsaldo (2)" }),
    ).toBeInTheDocument();
    expect(
      screen.getByText("Der Endsaldo ist bestätigt, sobald der Austrittsmonat abgeschlossen ist."),
    ).toBeInTheDocument();
    expect(screen.getByRole("columnheader", { name: "Austritt am" })).toBeInTheDocument();
    // Issue #588 (D-588-4/D-588-5): one column per value, the forecast label chosen from the data.
    expect(screen.getByRole("columnheader", { name: "Abgeschlossen" })).toBeInTheDocument();
    expect(
      screen.getByRole("columnheader", { name: "Seit Monatsabschluss (Prognose)" }),
    ).toBeInTheDocument();
    expect(screen.getByRole("columnheader", { name: "Gesamt" })).toBeInTheDocument();
    expect(screen.getByText("Person Nr1")).toBeInTheDocument();
    expect(screen.getByText("N-2")).toBeInTheDocument();
    expect(screen.getAllByTestId("exit-date").map((e) => e.textContent)).toEqual([
      "15.10.2026",
      "30.09.2026",
    ]);
    const confirmed = screen.getAllByTestId("saldo-cell-confirmed");
    expect(confirmed).toHaveLength(2);
    expect(confirmed.map((e) => e.textContent?.trim())).toEqual(["+2:00", "+2:00"]);
    expect(screen.getAllByTestId("saldo-cell-open").map((e) => e.textContent?.trim())).toEqual([
      "±0:00",
      "±0:00",
    ]);
    expect(screen.getAllByTestId("saldo-cell-total").map((e) => e.textContent?.trim())).toEqual([
      "+2:00",
      "+2:00",
    ]);
    // No compact SaldoAnzeige any more.
    expect(screen.queryByTestId("saldo-anzeige")).toBeNull();
    expect(screen.queryByTestId("exited-more")).toBeNull();
  });

  it("says how many exited persons are not shown when the total exceeds the rows", () => {
    const rows = Array.from({ length: 50 }, (_, i) => row(i, "2026-10-15"));
    renderWithTheme(ExitedFinalSaldoSection, { rows, total: 52 });
    expect(
      screen.getByRole("heading", { name: "Ausgetreten, offener Endsaldo (52)" }),
    ).toBeInTheDocument();
    expect(screen.getByTestId("exited-more")).toHaveTextContent("und 2 weitere");
  });

  it("shows dashes in the split cells and the total from balanceHours for a row without the split fields", () => {
    renderWithTheme(ExitedFinalSaldoSection, {
      rows: [{ ...row(3, "2026-10-15"), confirmedMinutes: undefined, openMonthMinutes: undefined }],
      total: 1,
    });
    expect(screen.getByText("Person Nr3")).toBeInTheDocument();
    expect(screen.getByTestId("saldo-cell-confirmed")).toHaveTextContent("—");
    expect(screen.getByTestId("saldo-cell-open")).toHaveTextContent("—");
    expect(screen.getByTestId("saldo-cell-total")).toHaveTextContent("+2:00");
  });

  it("renders nothing for an empty list with total 0", () => {
    renderWithTheme(ExitedFinalSaldoSection, { rows: [], total: 0 });
    expect(screen.queryByRole("heading")).toBeNull();
    expect(screen.queryByTestId("exited-final-saldo")).toBeNull();
  });
});

function readPage(): string {
  const rel = "../routes/(app)/reports/+page.svelte";
  try {
    return readFileSync(fileURLToPath(new URL(rel, import.meta.url)), "utf8");
  } catch {
    return readFileSync(resolve(process.cwd(), "src/routes/(app)/reports/+page.svelte"), "utf8");
  }
}

describe("/reports page wiring (Issue #613)", () => {
  const PAGE = readPage();

  it("the team table, its sorting, the KPIs and the team figures are derived from the active rows", () => {
    expect(PAGE).toContain(
      "let overtimeSections = $derived(partitionOvertimeOverview(overtimeOverview?.employees ?? []))",
    );
    expect(PAGE).toMatch(
      /let sortedOvertime = \$derived\.by\(\(\) => \{\s*const rows = overtimeSections\.active;/,
    );
    expect(PAGE).toContain("let kpiTeamSize = $derived(overtimeSections.active.length)");
    // Issue #588: the median figure replaces the mean over the active rows.
    expect(PAGE).toContain("let teamSaldo = $derived(teamSaldoFigures(overtimeSections.active))");
    expect(PAGE).toContain('overtimeSections.active.filter((r) => r.status === "CRITICAL")');
    // The table iterates the paged team rows, which slice sortedOvertime (Issue #588).
    expect(PAGE).toContain("{#each pagedOvertimeRows as row (row.id)}");
    expect(PAGE).toMatch(/let pagedOvertimeRows = \$derived\(\s*sortedOvertime\.slice\(/);
    expect(PAGE).not.toMatch(/overtimeOverview\?\.employees \?\? \[\]\)\.filter/);
  });

  it("the section receives the exited rows and the server's total; the types carry the new fields", () => {
    expect(PAGE).toContain("rows={overtimeSections.exitedOpen}");
    expect(PAGE).toContain("overtimeOverview.exitedOpenFinalSaldoCount");
    expect(PAGE).toContain("exitDate?: string | null;");
    expect(PAGE).toContain("exitedWithOpenFinalSaldo?: boolean;");
    expect(PAGE).toContain("exitedOpenFinalSaldoCount?: number;");
  });
});

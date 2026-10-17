// Issue #588 (AC-588-2/3/4, D-588-1/4/5) - source pins of the /reports team area. The page is not
// mountable (no `$app` alias in vitest.config.ts), so, like exited-final-saldo-section-613.test.ts,
// the wiring is pinned by reading the source. The figures themselves are unit-tested in
// lib/reports/__tests__/team-saldo-588.test.ts.
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, it, expect } from "vitest";

function readPage(): string {
  const rel = "../routes/(app)/reports/+page.svelte";
  try {
    return readFileSync(fileURLToPath(new URL(rel, import.meta.url)), "utf8");
  } catch {
    return readFileSync(resolve(process.cwd(), "src/routes/(app)/reports/+page.svelte"), "utf8");
  }
}

/** A web source file next to the tests, read by its path relative to `src/__tests__`. */
function readSource(rel: string): string {
  try {
    return readFileSync(fileURLToPath(new URL(rel, import.meta.url)), "utf8");
  } catch {
    return readFileSync(resolve(process.cwd(), "src/__tests__", rel), "utf8");
  }
}

// Issue #612 (pin ledger rows 4 and 5): the Überstunden-Übersicht card is gone. The team figures of
// the page are the period table's, in `lib/components/reports/TimesAccountsTable.svelte`; the
// page itself no longer touches the team saldo module. What each former assertion became:
//   - "reads the team figures, cells and the forecast label from the one module" -> the table
//     imports the module (and the status chip words the forecast through the one label rule)
//   - "the team median is shown with the persons outside it named" -> the median line of the table
//   - "a person outside the median carries a badge with the module's reason" -> the exclusion chip
//   - "each saldo cell is plain text, not a SaldoAnzeige" -> the table renders no SaldoAnzeige
//   - "the overview table has one column per value (Abgeschlossen / Prognose / Gesamt)", "the
//     incomplete-roster hint" and "the salon persons note" belong to the removed overview table:
//     a period row has one closing saldo and no live roster fact; the exited-persons section keeps
//     its own split columns and roster hint (exited-final-saldo-section-613.test.ts)
//   - the personal KPI, the removed Verlauf column and chart code stay pinned on the page
describe("/reports team area (Issue #588, period table of Issue #612)", () => {
  const PAGE = readPage();
  const TABLE = readSource("../lib/components/reports/TimesAccountsTable.svelte");
  const TABLE_LOGIC = readSource("../lib/reports/period-table.ts");

  it("walks a real page and a real table (vacuity)", () => {
    expect(PAGE.length).toBeGreaterThan(50_000);
    expect(PAGE).toContain("TimesAccountsTable");
    expect(TABLE.length).toBeGreaterThan(2_000);
    expect(TABLE_LOGIC.length).toBeGreaterThan(1_000);
  });

  it("the table reads the median, the exclusions and their labels from the one team saldo module", () => {
    for (const name of [
      "periodSaldoFigures",
      "periodSaldoExclusion",
      "TEAM_SALDO_EXCLUSION_LABEL",
    ]) {
      expect(TABLE).toMatch(
        new RegExp(
          `import \\{[^}]*\\b${name}\\b[^}]*\\} from "\\$lib\\/reports\\/team-saldo"`,
          "s",
        ),
      );
    }
    // The page keeps no team saldo derivation of its own any more.
    expect(PAGE).not.toContain("$lib/reports/team-saldo");
    expect(PAGE).not.toContain("teamSaldoFigures");
  });

  it("the status chip words the forecast through the one label rule, not a literal", () => {
    expect(TABLE_LOGIC).toMatch(/import \{ forecastLabel \} from "\$lib\/saldo\/forecast-label"/);
    expect(TABLE_LOGIC).toContain("forecastLabel(unconfirmed, hasClosedMonth)");
  });

  it("the team median is shown with the persons outside the figure named next to it", () => {
    expect(TABLE).toContain('data-testid="period-median"');
    expect(TABLE).toContain("Median Saldo am Ende");
    expect(TABLE).toContain("figures.medianMinutes");
    expect(TABLE).toContain("ohne Erfassung");
    expect(PAGE).not.toContain('label="Median-Saldo"');
    expect(PAGE).not.toContain("kpiAvgBalance");
    expect(PAGE).not.toContain('label="Ø Saldo"');
  });

  it("a person outside the median carries a chip with the reason from the module", () => {
    expect(TABLE).toContain("periodSaldoExclusion(row)");
    expect(TABLE).toContain("TEAM_SALDO_EXCLUSION_LABEL[");
  });

  it("the table renders plain text figures, not a SaldoAnzeige", () => {
    expect(TABLE.includes("<SaldoAnzeige")).toBe(false);
  });

  it("the personal KPI Saldo is formatted with fmtBalance", () => {
    expect(PAGE).toContain("value={fmtBalance(kpiTotalBalanceMin)}");
    expect(PAGE).not.toContain("fmtHoursSigned");
  });

  it("keeps the #542 salon wiring of the exited section", () => {
    expect(PAGE).toContain("overviewSalonRejected");
    expect(PAGE).toContain("SalonScopeLabel");
  });

  it("the empty Verlauf column and its chart code are gone", () => {
    expect(PAGE).not.toMatch(/sparkline/i);
    expect(PAGE).not.toContain("registerCanvas");
    expect(PAGE).not.toContain("Verlauf (6 Monate)");
    expect(PAGE).not.toContain("kein Verlauf");
    expect(PAGE).not.toContain("new Chart(");
    expect(PAGE).not.toContain('from "chart.js"');
    expect(PAGE).not.toContain("onDestroy");
    expect(PAGE).not.toContain("no-trend");
  });

  it("the Überstunden-Übersicht card, its sort and its per-row document buttons are gone", () => {
    expect(PAGE).not.toContain("Überstunden-Übersicht</");
    expect(PAGE).not.toContain('<CardHeader title="Überstunden-Übersicht"');
    expect(PAGE).not.toContain("sortedOvertime");
    expect(PAGE).not.toContain("pagedOvertimeRows");
    expect(PAGE).not.toContain("toggleSort");
    expect(PAGE).not.toContain("Stundennachweis PDF (");
    expect(PAGE).not.toContain("DATEV LODAS (");
  });
});

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

/** The source between two anchor strings (the first occurrence of each, `to` after `from`). */
function region(source: string, from: string, to: string): string {
  const start = source.indexOf(from);
  expect(start, `anchor not found: ${from}`).toBeGreaterThan(-1);
  const end = source.indexOf(to, start);
  expect(end, `anchor not found after ${from}: ${to}`).toBeGreaterThan(start);
  return source.slice(start, end);
}

describe("/reports team area (Issue #588)", () => {
  const PAGE = readPage();
  const CARD = region(
    PAGE,
    '<CardHeader title="Überstunden-Übersicht"',
    "<ExitedFinalSaldoSection",
  );

  it("walks a real page (vacuity)", () => {
    expect(PAGE.length).toBeGreaterThan(50_000);
    expect(PAGE).toContain("Überstunden-Übersicht");
    expect(CARD.length).toBeGreaterThan(500);
  });

  it("reads the team figures, cells and the forecast label from the one module", () => {
    expect(PAGE).toMatch(
      /import \{[^}]*\bteamSaldoFigures\b[^}]*\} from "\$lib\/reports\/team-saldo"/s,
    );
    expect(PAGE).toMatch(
      /import \{[^}]*\bteamSaldoCells\b[^}]*\} from "\$lib\/reports\/team-saldo"/s,
    );
    expect(PAGE).toMatch(
      /import \{[^}]*\bforecastColumnLabel\b[^}]*\} from "\$lib\/reports\/team-saldo"/s,
    );
    expect(PAGE).toContain("let teamSaldo = $derived(teamSaldoFigures(overtimeSections.active))");
  });

  it("the team KPI is the median with the persons outside the figure named next to it", () => {
    expect(PAGE).toContain('label="Median-Saldo"');
    expect(PAGE).toMatch(
      /value=\{teamSaldo\.medianMinutes === null \? "—" : fmtBalance\(teamSaldo\.medianMinutes\)\}/,
    );
    expect(PAGE).toContain("nicht in der Kennzahl");
    expect(PAGE).not.toContain("kpiAvgBalance");
    expect(PAGE).not.toContain('label="Ø Saldo"');
  });

  it("the overview table has one column per value, labelled from the data", () => {
    const head = region(CARD, "<thead>", "</thead>");
    expect(head).toContain("Abgeschlossen");
    expect(head).toContain("{forecastColumnLabel(overtimeSections.active)}");
    expect(head).toContain("Gesamt");
    expect(head).not.toContain("Saldo (h)");
    // The "Abgeschlossen" header keeps the sort of the former saldo header (confirmed key, 97-07).
    expect(head).toMatch(/onclick=\{\(\) => toggleSort\("balance"\)\}[\s\S]*?Abgeschlossen/);
  });

  it("each saldo cell reads teamSaldoCells(row) and the cells are plain text, not a SaldoAnzeige", () => {
    const body = region(CARD, "<tbody>", "</tbody>");
    expect(body).toContain("teamSaldoCells(row)");
    for (const id of ["saldo-cell-confirmed", "saldo-cell-open", "saldo-cell-total"]) {
      expect(body).toContain(`data-testid="${id}"`);
    }
    expect(CARD).not.toContain("<SaldoAnzeige");
  });

  it("a person outside the median carries a badge with the reason from the module", () => {
    const body = region(CARD, "<tbody>", "</tbody>");
    expect(body).toContain("teamSaldoExclusion(row)");
    expect(body).toContain("TEAM_SALDO_EXCLUSION_LABEL[");
    expect(body).toContain("Nicht im Median-Saldo");
  });

  it("a row with an incomplete roster keeps the hint in the open cell", () => {
    expect(CARD).toContain("row.rosterIncomplete");
    expect(CARD).toContain("Restmonat noch nicht vollständig verplant");
  });

  it("the personal KPI Saldo is formatted with fmtBalance", () => {
    expect(PAGE).toContain("value={fmtBalance(kpiTotalBalanceMin)}");
    expect(PAGE).not.toContain("fmtHoursSigned");
  });

  it("keeps the #542 salon wiring of the overview", () => {
    expect(PAGE).toContain("overviewSalonRejected");
    expect(PAGE).toContain("SalonScopeLabel");
    expect(CARD).toContain("PERSON_SALDO_NOT_SPLIT_LABEL");
    expect(CARD).toContain("overtime-salon-persons-note");
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

  it("the overview card sub-title no longer promises a Verlauf", () => {
    expect(PAGE).toContain(
      '<CardHeader title="Überstunden-Übersicht" sub="Saldo je Mitarbeiter" />',
    );
  });
});

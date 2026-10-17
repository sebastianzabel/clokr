// Issue #612 (D-612-1, D-612-7, AC-612-4, Pattern 3) - source pins of the rebuilt period area of
// /reports. The route imports `$app/*` and cannot be mounted (no `$app` alias in
// vitest.config.ts), so, like the 542/588/613 page pins, the wiring is proven by reading the
// source. The rendering of every block is mounted-tested in lib/components/reports/__tests__.
//
// What these pins hold on to:
//   - the period, tab, person and salon live in the URL and are read ONLY through
//     parsePeriodState and written ONLY through periodSearch + goto(replaceState)
//   - exactly one period control (one <PeriodBar>), the old team header selects are gone
//   - one request per (from, to, salon), only the latest answer is applied, nothing is summed
//   - the dialogs sit after the period panel, never inside an animated Card (Issue #570)
//   - the personal view and the other cards are untouched
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

const PAGE = readPage();
/** The script block (before the template): the logic the pins below inspect. */
const SCRIPT = PAGE.slice(0, PAGE.indexOf("</script>"));
/** The template (after the script, before the style block). */
const TEMPLATE = PAGE.slice(PAGE.indexOf("</script>"), PAGE.indexOf("<style>"));

/** The body of `[async ]function <name>(` up to its closing brace at the top level of the script. */
function functionBody(name: string): string {
  const start = SCRIPT.indexOf(`function ${name}(`);
  expect(start, `function ${name} not found`).toBeGreaterThan(-1);
  const end = SCRIPT.indexOf("\n  }\n", start);
  expect(end, `end of ${name} not found`).toBeGreaterThan(start);
  return SCRIPT.slice(start, end);
}

describe("/reports period area (Issue #612) - the URL is the one state", () => {
  it("[vacuity gate] the page source is loaded and carries the period bar", () => {
    expect(PAGE.length).toBeGreaterThan(1_000);
    expect(SCRIPT.length).toBeGreaterThan(1_000);
    expect(TEMPLATE.length).toBeGreaterThan(1_000);
    expect(PAGE).toContain("PeriodBar");
  });

  it("parses the URL only through parsePeriodState and writes it only through periodSearch", () => {
    expect(PAGE).toMatch(
      /import \{[^}]*\bparsePeriodState\b[^}]*\} from "\$lib\/reports\/period-state"/s,
    );
    expect(PAGE).toMatch(
      /import \{[^}]*\bperiodSearch\b[^}]*\} from "\$lib\/reports\/period-state"/s,
    );
    expect(PAGE).toContain("parsePeriodState($page.url.searchParams, today, rights.periodTabs)");
    // No second reader of the URL: the page never asks the search params for the state itself.
    expect(PAGE).not.toMatch(/searchParams\.get\(\s*["'](from|to|tab|person|salonId)["']/);
    expect(PAGE).not.toMatch(/new URLSearchParams\(/);
  });

  it("every period or tab change is a replaceState navigation that keeps focus and scroll", () => {
    const body = functionBody("writeState");
    expect(body).toContain("periodSearch(next)");
    expect(body).toMatch(/replaceState: true,\s+keepFocus: true,\s+noScroll: true/);
    // Every goto( of the page replaces the history entry except the ONE push: opening a person.
    const calls = [...SCRIPT.matchAll(/goto\(/g)].length;
    const replaced = [...SCRIPT.matchAll(/replaceState: true/g)].length;
    expect(calls).toBeGreaterThanOrEqual(2);
    expect(replaced).toBe(calls - 1);
  });

  it("opening a person is the only history push: it follows the person link, plain left click only", () => {
    const body = functionBody("openPerson");
    expect(body).toContain("if (!isPlainLeftClick(event)) return;");
    expect(body).toContain("event.preventDefault();");
    expect(body).toMatch(/goto\(personHref\(row\), \{ keepFocus: true, noScroll: true \}\)/);
    expect(body).not.toContain("replaceState");
    expect(functionBody("personHref")).toContain(
      "periodSearch({ ...urlState, person: row.employeeId })",
    );
  });

  it("the tab list is an ARIA tablist named Berichtsbereich with a roving tabindex", () => {
    expect(TEMPLATE).toContain('role="tablist"');
    expect(TEMPLATE).toContain('aria-label="Berichtsbereich"');
    expect(TEMPLATE).toContain('role="tab"');
    expect(TEMPLATE).toContain("tabindex={tab === activeTab ? 0 : -1}");
    expect(TEMPLATE).toContain("{#each rights.periodTabs as tab (tab)}");
    const keys = functionBody("onTabKeydown");
    for (const key of ["ArrowRight", "ArrowLeft", "Home", "End"]) expect(keys).toContain(key);
  });

  it("the tabs come from the permissions (reportRights.periodTabs), never from a role", () => {
    expect(SCRIPT).toContain("rights.periodTabs");
    expect(PAGE).not.toMatch(/\.role\b/);
  });
});

describe("/reports period area (Issue #612) - one period control, no old selects", () => {
  it("renders <PeriodBar exactly once", () => {
    expect((TEMPLATE.match(/<PeriodBar\b/g) ?? []).length).toBe(1);
    expect((PAGE.match(/<PeriodBar\b/g) ?? []).length).toBe(1);
  });

  it("the old team header (Team-Übersicht with its month and year selects) is gone", () => {
    expect(PAGE).not.toContain("Team-Übersicht");
    expect(PAGE).not.toContain("team-period-controls");
    expect(PAGE).not.toContain("team-overview-header");
    expect(PAGE).not.toMatch(/bind:value=\{selectedMonth\}/);
    expect(PAGE).not.toMatch(/bind:value=\{selectedYear\}/);
    // The old per-card team selectors: the remaining selects belong to the export cards and the
    // carry-over horizon until 612-06 replaces them.
    expect(PAGE).not.toContain("let selectedMonth = $state");
    expect(PAGE).not.toContain("let selectedYear = $state");
  });

  it("the old team KPI row is gone and the personal KPI row stays", () => {
    expect(PAGE).not.toContain('label="Mitarbeiter"');
    expect(PAGE).not.toContain('label="Kritische Salden"');
    expect(PAGE).not.toContain('label="Urlaub genutzt"');
    expect(PAGE).toContain('<KPIStat label="Abgeschlossen"');
    expect(PAGE).toContain("<PeriodKpis");
  });

  it("PageHead names the team eyebrow for team callers and keeps the personal one", () => {
    expect(TEMPLATE).toContain('eyebrow={showTeamArea ? "Team" : "Mein Bereich"}');
    expect(TEMPLATE).toContain(
      '"Zeiten, Konten und Urlaub für einen Zeitraum – bis zu 12 Monate."',
    );
    expect(TEMPLATE).toContain('"Persönliche Monatsabschlüsse — als PDF zum Download."');
  });

  it("the sticky bar's height reaches the table header as --period-bar-h", () => {
    expect(TEMPLATE).toContain("onHeight={(px) => (barHeight = px)}");
    expect(TEMPLATE).toContain("--period-bar-h: {barHeight}px");
  });
});

describe("/reports period area (Issue #612) - one request, the latest answer, no summing", () => {
  it("requests the period answer only through periodReportPath, once, with the abort signal", () => {
    expect((SCRIPT.match(/periodReportPath\(/g) ?? []).length).toBe(1); // the one call
    // The request path is never spelled out here ($lib/reports/period-state is a module path).
    expect(PAGE).not.toMatch(/["`']\/reports\/period/);
    const body = functionBody("loadPeriod");
    expect(body).toContain("api.get<PeriodReport>(periodReportPath(from, to, salon), {");
    expect(body).toContain("signal: controller.signal");
  });

  it("applies only the latest answer: a monotonic request counter and an abort of the old read", () => {
    const body = functionBody("loadPeriod");
    expect(body).toContain("const generation = ++periodGeneration;");
    expect(body).toContain("periodAbort?.abort();");
    expect((body.match(/if \(generation !== periodGeneration\) return;/g) ?? []).length).toBe(2);
    expect(body).toContain("if (generation === periodGeneration) periodLoading = false;");
  });

  it("a timeout or a failed read is a calm error with Erneut versuchen, a 400 offers the current month", () => {
    const body = functionBody("loadPeriod");
    expect(body).toContain("PERIOD_TIMEOUT_MS");
    expect(body).toContain('e instanceof ApiError && e.status === 400 ? "INVALID" : "FAILED"');
    expect(TEMPLATE).toContain("Erneut versuchen");
    expect(TEMPLATE).toContain("Zum aktuellen Monat");
    expect(TEMPLATE).toContain(
      "Dieser Zeitraum lässt sich nicht auswerten – höchstens 12 Monate auf einmal.",
    );
    expect(TEMPLATE).toContain(
      "Der Bericht konnte nicht geladen werden. Prüfen Sie die Verbindung und versuchen Sie es",
    );
  });

  it("dims the previous figures while a later load runs and announces the period and the count", () => {
    expect(TEMPLATE).toContain("period-body--dim");
    expect(TEMPLATE).toContain("periodLoading && period !== null");
    const body = functionBody("loadPeriod");
    expect(body).toContain("`Zeitraum: ${periodLabel(from, to, today)}`");
    expect(body).toContain('`Bericht geladen: ${n} ${n === 1 ? "Person" : "Personen"}`');
    expect(TEMPLATE).toContain('role="status" aria-live="polite"');
  });

  it("sums and recomputes nothing: no reduce over the period answer, no Math in the load", () => {
    const body = functionBody("loadPeriod");
    expect(body).not.toMatch(/\.reduce\(/);
    expect(body).not.toMatch(/Math\./);
    expect(SCRIPT).not.toMatch(/period\??\.rows\.(reduce|map|filter)\(/);
    expect(SCRIPT).not.toMatch(/period\??\.kpis\.\w+\s*[-+*/]/);
  });

  it("does not request the period on the Heute tab (it has no period)", () => {
    expect(SCRIPT).toContain(
      'const periodTabActive = $derived(activeTab === "zeiten" || activeTab === "urlaub");',
    );
    expect(SCRIPT).toContain("const wanted = canReportRead && periodTabActive;");
  });

  it("a tab change or a drill-down push does not re-trigger the request (primitive key)", () => {
    expect(SCRIPT).toContain("const periodKey = $derived(");
    expect(SCRIPT).toContain("void periodKey;");
  });
});

describe("/reports period area (Issue #612) - dialogs, export-only callers, interim card", () => {
  it("the range dialog sits after the period panel, never inside it", () => {
    const panelStart = TEMPLATE.indexOf('class="page period-content"');
    const panelEnd = TEMPLATE.indexOf("<PeriodRangeDialog");
    expect(panelStart).toBeGreaterThan(-1);
    expect(panelEnd).toBeGreaterThan(panelStart);
    expect(TEMPLATE.slice(panelStart, panelEnd)).not.toContain("<Modal");
  });

  it("a caller who may export but read no report gets the bar and a short note, no tabs (amendment 5)", () => {
    expect(SCRIPT).toContain(
      "const exportOnly = $derived(showTeamArea && rights.periodTabs.length === 0);",
    );
    expect(TEMPLATE).toContain("{#if periodTabActive || exportOnly}");
    expect(TEMPLATE).toContain("{#if exportOnly}");
    expect(TEMPLATE).toContain("Keine Auswertung freigegeben – Exporte verfügbar");
    expect(TEMPLATE).toContain("canExport={canReportExport}");
    expect(TEMPLATE).toContain("{#if rights.periodTabs.length > 0}");
  });

  it("the Überstunden-Übersicht card is replaced by the period table; the exited section stays under it", () => {
    expect(TEMPLATE).toContain("<TimesAccountsTable");
    expect((TEMPLATE.match(/<TimesAccountsTable\b/g) ?? []).length).toBe(1);
    expect(PAGE).not.toContain('<CardHeader title="Überstunden-Übersicht"');
    expect(TEMPLATE).toContain("exited={exitedBlock}");
    // The table gets the server's rows as they are; the page never sums or sorts them.
    expect(TEMPLATE).toContain("rows={period?.rows ?? null}");
    expect(TEMPLATE).toContain("{personHref}");
    expect(TEMPLATE).toContain("onOpenPerson={openPerson}");
  });

  it("the exited section (and so the saldo overview request) needs team-overview plus overtime rights only", () => {
    const at = PAGE.indexOf("{#snippet exitedBlock()}");
    expect(at).toBeGreaterThan(-1);
    const block = PAGE.slice(at, PAGE.indexOf("{/snippet}", at));
    expect(block).toContain("{#if canTeamOvertime}");
    expect(block).toContain("<ExitedFinalSaldoSection");
    expect(SCRIPT).toContain("const overview = canTeamOvertime;");
  });

  it("the attendance card and the vacation cards moved into their tabs without losing their rights", () => {
    expect(TEMPLATE).toContain("{@render attendanceBlock()}");
    expect(TEMPLATE).toContain("{@render carryoverBlock()}");
    expect(TEMPLATE).toContain("{@render leaveOverviewBlock()}");
    expect(PAGE).toContain("{#if canTeamAttendance}");
    expect(PAGE).toContain("{#if canReportRead}");
    // The vacation year follows the period's end (bridge until 612-06).
    expect(SCRIPT).toContain("const selectedYear = $derived(urlState.to.year);");
  });
});

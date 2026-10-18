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
    // The old per-card team selectors: the remaining selects belong to the export cards until
    // 612-06 replaces them (the carry-over horizon select went with the Verfall card).
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

  it("the attendance card moved into its tab and the vacation tab renders from the period answer", () => {
    expect(TEMPLATE).toContain("{@render attendanceBlock()}");
    expect(PAGE).toContain("{#if canTeamAttendance}");
    // The vacation tab needs report:read: the tab itself comes from reportRights.periodTabs and the
    // period request is gated by it.
    expect(SCRIPT).toContain("const wanted = canReportRead && periodTabActive;");
    // Issue #612 (612-06): the two vacation cards, their loads and the year bridge are gone; the tab
    // takes vacation and absences from the one answer.
    expect((TEMPLATE.match(/<VacationAbsenceTab\b/g) ?? []).length).toBe(1);
    expect(TEMPLATE).toContain("vacation={period?.vacation ?? null}");
    expect(TEMPLATE).toContain("absences={period?.absences ?? null}");
    expect(TEMPLATE).toContain("canNotify={canReportNotify}");
    expect(PAGE).not.toContain("carryoverBlock");
    expect(PAGE).not.toContain("leaveOverviewBlock");
    expect(SCRIPT).not.toContain("selectedYear");
    expect(SCRIPT).not.toContain("selectedMonth");
    expect(PAGE).not.toContain("carryoverHorizon");
  });

  it("the notice is the existing carry-over route with the entitlement id, and re-reads nothing", () => {
    const body = functionBody("sendCarryoverNotice");
    expect(body).toContain('"/reports/carryover-warn"');
    expect(body).toContain("{ entitlementId }");
    expect(TEMPLATE).toContain("onNotify={sendCarryoverNotice}");
  });

  it("the vacation table links only persons the drill-down can show (a row of the period answer)", () => {
    expect(functionBody("vacationPersonHref")).toContain(
      "period?.rows.find((r) => r.employeeId === employeeId)",
    );
    expect(functionBody("vacationPersonHref")).toContain("row ? personHref(row) : null");
    expect(functionBody("openVacationPerson")).toContain("openPerson(event, row)");
  });
});

describe("/reports period area (Issue #612) - the person drill-down", () => {
  it("renders one <PersonDrilldown after the period panel and the range dialog, never inside it", () => {
    expect((TEMPLATE.match(/<PersonDrilldown\b/g) ?? []).length).toBe(1);
    const panel = TEMPLATE.indexOf('class="page period-content"');
    const range = TEMPLATE.indexOf("<PeriodRangeDialog");
    const drill = TEMPLATE.indexOf("<PersonDrilldown");
    expect(panel).toBeGreaterThan(-1);
    expect(range).toBeGreaterThan(panel);
    expect(drill).toBeGreaterThan(range);
  });

  it("the URL decides what is open: person= must name a row of the answer, on a period tab only", () => {
    expect(SCRIPT).toContain("periodTabActive && urlState.person !== null");
    expect(SCRIPT).toContain("period?.rows.find((r) => r.employeeId === urlState.person)");
    expect(SCRIPT).toContain("let drillOpen = $derived(drillRow !== null);");
    expect(TEMPLATE).toContain("bind:open={drillOpen}");
    expect(TEMPLATE).toContain("row={drillRow}");
  });

  it("opening is the one push and remembers it; closing pops that push or drops person with a replaceState", () => {
    expect(functionBody("openPerson")).toContain("drillPushed = true;");
    const body = functionBody("closeDrill");
    expect(body).toContain("if (drillPushed) {");
    expect(body).toContain("history.back();");
    expect(body).toContain("writeState({ ...urlState, person: null });");
    // A close that finds the URL already without person (Back was pressed) pushes nothing.
    expect(body).toMatch(/if \(urlState\.person === null\) \{\s+drillPushed = false;\s+return;/);
    expect(TEMPLATE).toContain("onClose={closeDrill}");
  });

  it("focus returns to the stored trigger when the range dialog or the drill-down closes", () => {
    expect(SCRIPT).toContain("const open = rangeOpen || drillOpen;");
    expect(SCRIPT).toContain("focusReturnTo?.focus();");
    expect(functionBody("openPerson")).toContain("focusReturnTo =");
  });

  it("a reloaded person= that names nobody in the answer is dropped quietly (amendment 6)", () => {
    const at = SCRIPT.indexOf("if (period.rows.some((r) => r.employeeId === person)) return;");
    expect(at).toBeGreaterThan(-1);
    const head = SCRIPT.lastIndexOf("$effect(() => {", at);
    const effect = SCRIPT.slice(head, SCRIPT.indexOf("\n  });", at));
    // Only a settled, current answer may decide: not while loading, not after a failure, not stale.
    expect(effect).toContain("periodLoading");
    expect(effect).toContain("periodFailure !== null");
    expect(effect).toContain('periodLoadedKey !== `${periodKey}|${pageSalonId ?? ""}`');
    expect(effect).toContain("writeState({ ...urlState, person: null })");
    expect(effect).not.toContain("toasts");
    expect(effect).not.toContain("periodFailure =");
  });

  it("the day list is requested by exactly one function, which only the drill-down component calls", () => {
    expect((SCRIPT.match(/\/time-entries/g) ?? []).length).toBe(1);
    expect(functionBody("loadDayEntries")).toContain("/time-entries?employeeId=");
    expect(TEMPLATE).toContain("canTimeEntryRead={rights.canTimeEntryRead}");
    expect(TEMPLATE).toContain("{loadDayEntries}");
    // No other caller in the page: the only references are the definition and the prop.
    expect((PAGE.match(/loadDayEntries\(/g) ?? []).length).toBe(1);
  });

  it("the person documents are the page's blob downloads, for the month the modal names", () => {
    const pdf = functionBody("downloadEmployeePdf");
    expect(pdf).toContain(
      "/reports/monthly/pdf?employeeId=${employeeId}&year=${target.year}&month=${target.month}",
    );
    expect(pdf).toContain("toasts.error(");
    const datev = functionBody("downloadEmployeeDatev");
    expect(datev).toContain(
      "/api/v1/reports/datev/employee?employeeId=${employeeId}&year=${target.year}&month=${target.month}",
    );
    expect(datev).toContain("toasts.error(");
    expect(TEMPLATE).toContain("{canReportExport}");
    expect(TEMPLATE).toContain(
      "downloadEmployeePdf(drillRow.employeeId, drillRow.employeeName, target)",
    );
    expect(TEMPLATE).toContain(
      "downloadEmployeeDatev(drillRow.employeeId, drillRow.employeeName, target)",
    );
    // The old per-row error state is gone with the buttons.
    expect(PAGE).not.toContain("empDownloadErrors");
  });

  it("the salon column of the day list follows the #64 rule", () => {
    expect(TEMPLATE).toContain("showSalonColumn={showSalonOptions($salonContext)}");
  });
});

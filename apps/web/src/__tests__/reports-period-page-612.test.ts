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
//
// Issue #612 (612-06, AC-612-1): the closing guard at the end of this file proves that exactly ONE
// period control is left on the page - one <PeriodBar>, no month or year select in the team area
// outside the two dialogs - and that every period figure comes from the one period answer. It also
// holds the states (skeleton, dimmed reload, error, empty) and the staggered reveal of the blocks.
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, it, expect, vi } from "vitest";
import { screen, within } from "@testing-library/svelte";
import { renderWithTheme } from "$tests/test-utils";
import { reportRights } from "$lib/page-rights";
import { PERIOD_PERSON_ABSENCE_CODES, type PeriodRow } from "$lib/reports/period-report";
import TimesAccountsTable from "$lib/components/reports/TimesAccountsTable.svelte";
import VacationAbsenceTab from "$lib/components/reports/VacationAbsenceTab.svelte";
import PeriodKpis from "$lib/components/reports/PeriodKpis.svelte";
import TodayAttendance from "$lib/components/reports/TodayAttendance.svelte";

// The components reach the page-scope module and with it the api client and its auth store
// (localStorage bootstrap); a stand-in keeps this file free of that (as in page-scope.test.ts).
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

  it("gives up before the 30 s abort of the API proxy, which stays as it is (Issue #688)", () => {
    const declared = SCRIPT.match(/const PERIOD_TIMEOUT_MS = ([\d_]+);/);
    expect(declared).not.toBeNull();
    expect(Number(declared![1].replace(/_/g, ""))).toBeLessThan(30_000);
    const hooksRel = "../hooks.server.ts";
    let hooks: string;
    try {
      hooks = readFileSync(fileURLToPath(new URL(hooksRel, import.meta.url)), "utf8");
    } catch {
      hooks = readFileSync(resolve(process.cwd(), "src/hooks.server.ts"), "utf8");
    }
    expect(hooks).toContain("signal: AbortSignal.timeout(30_000)");
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

describe("/reports period area (Issue #612) - dialogs, export-only callers, tabs", () => {
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

  it("the attendance list is the tab „Heute“ component and the vacation tab renders from the period answer", () => {
    expect((TEMPLATE.match(/<TodayAttendance\b/g) ?? []).length).toBe(1);
    expect(PAGE).not.toContain("attendanceBlock");
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

  // Issue #713 (D-10): the card „Abwesenheiten je Person“ sits in the vacation tab right after the
  // tab's own cards and renders the one period answer's rows - the page derives nothing.
  it("the vacation tab renders the card „Abwesenheiten je Person“ after the tab, from the period rows (Issue #713)", () => {
    expect((TEMPLATE.match(/<AbsencesByPersonTable\b/g) ?? []).length).toBe(1);
    const branch = TEMPLATE.indexOf('{:else if activeTab === "urlaub"}');
    expect(branch).toBeGreaterThan(-1);
    const card = TEMPLATE.indexOf("<AbsencesByPersonTable");
    expect(card).toBeGreaterThan(branch);
    expect(card).toBeGreaterThan(TEMPLATE.indexOf("<VacationAbsenceTab"));
    // still inside the urlaub branch: neither another branch nor a closing {/if} lies between
    expect(TEMPLATE.slice(branch + 1, card)).not.toMatch(/\{:else|\{\/if\}/);
    const tag = TEMPLATE.slice(card, TEMPLATE.indexOf("/>", card));
    expect(tag).toContain("rows={period?.rows ?? null}");
    expect(tag).toContain("loading={periodLoading}");
    expect(tag).toContain("filterActive={pageSalonId !== null}");
    expect(tag).toContain("{personHref}");
    expect(tag).toContain("onOpenPerson={openPerson}");
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
    expect(SCRIPT).toContain("const open = rangeOpen || exportOpen || drillOpen;");
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

describe("/reports period area (Issue #612, 612-06) - the Heute tab and the one export dialog", () => {
  it("the Heute panel has no period bar, no KPIs and renders the list only with team-overview rights", () => {
    const panel = TEMPLATE.indexOf('id="reports-panel-heute"');
    expect(panel).toBeGreaterThan(-1);
    const block = TEMPLATE.slice(panel, TEMPLATE.indexOf("<PeriodRangeDialog", panel));
    expect(block).toContain("{#if canTeamAttendance}");
    expect(block).toContain("<TodayAttendance");
    expect(block).not.toContain("<PeriodBar");
    expect(block).not.toContain("<PeriodKpis");
    expect(block).toContain("attendance={todayAttendance}");
    expect(block).toContain("rejected={attendanceSalonRejected}");
  });

  it("the bar's Exportieren button opens the dialog and remembers its trigger for the focus return", () => {
    const body = functionBody("openExport");
    expect(body).toContain("focusReturnTo = trigger;");
    expect(body).toContain("exportOpen = true;");
    expect(TEMPLATE).toContain("onOpenExport={openExport}");
  });

  it("renders one <ExportDialog after the period panel, only for report:export", () => {
    expect((TEMPLATE.match(/<ExportDialog\b/g) ?? []).length).toBe(1);
    const panel = TEMPLATE.indexOf('class="page period-content"');
    const dialog = TEMPLATE.indexOf("<ExportDialog");
    expect(dialog).toBeGreaterThan(panel);
    expect(TEMPLATE.slice(TEMPLATE.lastIndexOf("{#if", dialog), dialog)).toContain(
      "{#if canReportExport}",
    );
    expect(TEMPLATE).toContain("bind:open={exportOpen}");
  });

  it("wires the three downloads, the § 9 loader and the error toast", () => {
    for (const wiring of [
      "loadSection9Note={loadExportSection9Note}",
      "onMonthlyExport={downloadMonthlyExport}",
      "onDatev={downloadDatev}",
      "onCsv={downloadPeriodCsv}",
      "onError={(message) => toasts.error(message)}",
    ]) {
      expect(TEMPLATE, wiring).toContain(wiring);
    }
  });

  it("Monatsexport and CSV carry the salon, DATEV never does", () => {
    expect(functionBody("downloadMonthlyExport")).toContain("withSalonId(");
    expect(functionBody("downloadPeriodCsv")).toContain("pageSalonId");
    expect(functionBody("downloadDatev")).not.toContain("pageSalonId");
    expect(functionBody("downloadDatev")).not.toContain("withSalonId(");
  });

  it("the CSV is saved as Zeiten-und-Konten_<from>_<to>.csv", () => {
    expect(functionBody("downloadPeriodCsv")).toContain(
      "`Zeiten-und-Konten_${ymKey(urlState.from)}_${ymKey(urlState.to)}.csv`",
    );
  });

  it("the old DATEV and Monatsexport cards, their selects and state are gone", () => {
    for (const gone of [
      "datev-month",
      "datev-year",
      "export-month",
      "export-year",
      "datevMonth",
      "datevYear",
      "exportMonth",
      "exportYear",
      "exportSection9Note",
      "reports-grid",
      "report-card",
      "DATEV Export",
    ]) {
      expect(PAGE, gone).not.toContain(gone);
    }
  });
});

// ── 612-06: exactly one period control (AC-612-1), states, staggered reveal ──────────────────────

function readSource(relative: string): string {
  try {
    return readFileSync(fileURLToPath(new URL(relative, import.meta.url)), "utf8");
  } catch {
    return readFileSync(resolve(process.cwd(), "src", relative.replace(/^\.\.\//, "")), "utf8");
  }
}

const COMPONENT_NAMES = [
  "PeriodBar",
  "PeriodKpis",
  "PeriodRangeDialog",
  "PersonDrilldown",
  "TimesAccountsTable",
  "VacationAbsenceTab",
  "TodayAttendance",
  "ExportDialog",
] as const;
type ComponentName = (typeof COMPONENT_NAMES)[number];

const COMPONENTS = Object.fromEntries(
  COMPONENT_NAMES.map((name) => [name, readSource(`../lib/components/reports/${name}.svelte`)]),
) as Record<ComponentName, string>;

const countOf = (text: string, needle: string | RegExp): number =>
  typeof needle === "string" ? text.split(needle).length - 1 : (text.match(needle) ?? []).length;

describe("/reports (Issue #612, AC-612-1) - exactly one period control", () => {
  it("[vacuity gate] the page and the eight components are loaded and non-empty", () => {
    expect(PAGE.length).toBeGreaterThan(30_000);
    expect(COMPONENT_NAMES).toHaveLength(8);
    for (const name of COMPONENT_NAMES) {
      expect(COMPONENTS[name].length, name).toBeGreaterThan(1_000);
    }
  });

  it("the team area of the page has one <PeriodBar and no <select at all", () => {
    expect(countOf(TEMPLATE, "<PeriodBar")).toBe(1);
    expect(countOf(TEMPLATE, /<select\b/g)).toBe(0);
    expect(countOf(SCRIPT, /<select\b/g)).toBe(0);
  });

  it("the only month or year selects live in the two dialogs; the table holds one narrow sort select", () => {
    const selects = Object.fromEntries(
      COMPONENT_NAMES.map((name) => [name, countOf(COMPONENTS[name], /<select\b/g)]),
    );
    // PeriodRangeDialog: month and year of „Von“ and „Bis“; ExportDialog: the month of
    // Monatsexport and DATEV; TimesAccountsTable: the sort select of the narrow list, nothing else.
    expect(selects).toEqual({
      PeriodBar: 0,
      PeriodKpis: 0,
      PeriodRangeDialog: 4,
      PersonDrilldown: 0,
      TimesAccountsTable: 1,
      VacationAbsenceTab: 0,
      TodayAttendance: 0,
      ExportDialog: 1,
    });
    expect(COMPONENTS.TimesAccountsTable).toContain('aria-label="Sortieren nach"');
    expect(COMPONENTS.ExportDialog).toContain("Monat für Monatsexport und DATEV");
  });

  it("the page asks for no vacation, carry-over or monthly route except the § 9 note", () => {
    expect(PAGE).not.toContain("/reports/leave-overview");
    expect(PAGE).not.toContain("/reports/carryover-at-risk");
    // `/reports/monthly?` is the § 9 note and nothing else (the PDFs are `/reports/monthly/pdf`).
    expect(countOf(PAGE, "/reports/monthly?")).toBe(1);
    expect(functionBody("loadExportSection9Note")).toContain("/reports/monthly?");
    // The components name no export or period route at all.
    for (const name of COMPONENT_NAMES) {
      for (const route of [
        "/reports/leave-overview",
        "/reports/carryover-at-risk",
        "/reports/monthly",
      ]) {
        expect(COMPONENTS[name], `${name} ${route}`).not.toContain(route);
      }
    }
  });

  it("every period figure is the period answer's: no reduce over period rows in the page or the components", () => {
    // The page's only reduce calls are the personal view's closed months (the EMP-06 table).
    const reduces = [...PAGE.matchAll(/(\w+)\.reduce\(/g)].map((m) => m[1]);
    expect(reduces.length).toBeGreaterThan(0);
    expect(new Set(reduces)).toEqual(new Set(["empClosedRows"]));
    for (const name of COMPONENT_NAMES) {
      expect(COMPONENTS[name], name).not.toContain("reduce(");
    }
    // team-saldo.ts is the one aggregator of the saldo figures (the #588 guard names it).
    expect(COMPONENTS.TimesAccountsTable).toContain('from "$lib/reports/team-saldo"');
  });

  it("the three dialogs render after .period-content, never inside it or an animated Card (#570)", () => {
    const panel = TEMPLATE.indexOf('class="page period-content"');
    expect(panel).toBeGreaterThan(-1);
    for (const tag of ["<PeriodRangeDialog", "<ExportDialog", "<PersonDrilldown"]) {
      expect(TEMPLATE.indexOf(tag), tag).toBeGreaterThan(panel);
    }
    // Nothing between the panel and the first dialog opens a Modal or a Card.
    const firstDialog = Math.min(
      ...["<PeriodRangeDialog", "<ExportDialog", "<PersonDrilldown"].map((t) =>
        TEMPLATE.indexOf(t),
      ),
    );
    expect(TEMPLATE.slice(panel, firstDialog)).not.toContain("<Modal");
  });
});

describe("/reports (Issue #612) - who sees what is decided by permissions", () => {
  // Every subset of the five team permissions: a caller in the team area with no period tab must be
  // able to export (the bar with the dialog and the short note), so the „no rights“ EmptyState of the
  // UI contract is unreachable by construction - showTeamArea needs one of the four rights, and
  // each of the three others yields a tab.
  const PERMISSIONS = [
    "team-overview:read:ZUGEWIESEN",
    "overtime:read:ZUGEWIESEN",
    "report:read:ZUGEWIESEN",
    "report:export:ZUGEWIESEN",
    "report:notify:ZUGEWIESEN",
  ];

  it("a team-area caller without a period tab always holds report:export", () => {
    let combinations = 0;
    for (let mask = 0; mask < 1 << PERMISSIONS.length; mask++) {
      const permissions = PERMISSIONS.filter((_, i) => (mask & (1 << i)) !== 0);
      const rights = reportRights({ permissions });
      combinations += 1;
      const exportOnly = rights.showTeamArea && rights.periodTabs.length === 0;
      if (exportOnly) expect(rights.canReportExport, permissions.join(",")).toBe(true);
    }
    expect(combinations).toBe(32);
  });

  it("a holder of team-overview:read without report:read sees only the Heute tab by default", () => {
    const rights = reportRights({ permissions: ["team-overview:read:ZUGEWIESEN"] });
    expect([...rights.periodTabs]).toEqual(["heute"]);
  });
});

function person(id: string): PeriodRow {
  return {
    employeeId: id,
    employeeName: `Person ${id}`,
    employeeNumber: `N-${id}`,
    hasRecordedTime: true,
    exitDay: null,
    workedMinutes: 600,
    expectedMinutes: 600,
    balanceMinutes: 0,
    openingBalanceMinutes: 0,
    closingBalanceMinutes: 0,
    closingConfirmedMinutes: null,
    closingOpenMinutes: null,
    unconfirmedMonths: null,
    monthCount: 1,
    confirmedMonthCount: 1,
    labelled: true,
    sickDays: 0,
    // Issue #713: the server always sends the ten counts.
    absence: Object.fromEntries(
      PERIOD_PERSON_ABSENCE_CODES.map((code) => [code, 0]),
    ) as PeriodRow["absence"],
    months: [],
  };
}

const TABLE_PROPS = {
  loading: false,
  periodLabel: "September 2026",
  filterActive: false,
  personHref: (r: PeriodRow) => `/reports?person=${r.employeeId}`,
  onOpenPerson: () => {},
};

describe("/reports (Issue #612) - states of the period area", () => {
  it("the first load shows skeletons with aria-busy in the KPI card and in both tabs", () => {
    const kpis = renderWithTheme(PeriodKpis, { kpis: null, filterActive: false, loading: true });
    expect(screen.getByTestId("period-kpis").getAttribute("aria-busy")).toBe("true");
    expect(screen.getByTestId("period-kpis-skeleton")).toBeTruthy();
    kpis.unmount();
    const table = renderWithTheme(TimesAccountsTable, {
      ...TABLE_PROPS,
      rows: null,
      loading: true,
    });
    expect(screen.getByTestId("period-section").getAttribute("aria-busy")).toBe("true");
    expect(screen.getByTestId("period-table-skeleton")).toBeTruthy();
    expect(screen.getByText("Bericht wird geladen…")).toBeTruthy();
    table.unmount();
    renderWithTheme(VacationAbsenceTab, {
      vacation: null,
      absences: null,
      filterActive: false,
      loading: true,
      today: "2026-10-15",
      canNotify: false,
      periodLabel: "September 2026",
      personHref: () => null,
      onOpenPerson: () => {},
      onNotify: async () => ({ warned: 0, skippedDedup: 0 }),
    });
    expect(screen.getByTestId("vacation-skeleton").getAttribute("aria-busy")).toBe("true");
    expect(screen.getByText("Lade Urlaubsübersicht…")).toBeTruthy();
  });

  it("a later load dims the previous figures instead of replacing them with a skeleton", () => {
    expect(TEMPLATE).toContain("class:period-body--dim={periodLoading && period !== null}");
    // The same class on the tab content wrapper: figures stay, opacity drops.
    expect(countOf(TEMPLATE, "period-body--dim")).toBe(2);
    expect(PAGE).toMatch(/\.period-body--dim\s*\{\s*opacity: 0\.6;/);
    // The table shows rows while loading when it already holds them (no skeleton with data).
    const withRows = renderWithTheme(TimesAccountsTable, {
      ...TABLE_PROPS,
      rows: [person("A")],
      loading: true,
    });
    expect(screen.queryByTestId("period-table-skeleton")).toBeNull();
    expect(within(screen.getByTestId("period-section")).getAllByRole("row").length).toBeGreaterThan(
      1,
    );
    withRows.unmount();
  });

  it("failure states: error callout with a retry, the invalid period offers the current month", () => {
    expect(TEMPLATE).toContain('class="callout error" role="alert" data-testid="period-error"');
    expect(TEMPLATE).toContain('class="callout error" role="alert" data-testid="period-invalid"');
    expect(TEMPLATE).toContain("Erneut versuchen");
    expect(TEMPLATE).toContain("Zum aktuellen Monat");
  });

  it("empty states: no persons, no search hit, no vacation rows, no absences", () => {
    const none = renderWithTheme(TimesAccountsTable, { ...TABLE_PROPS, rows: [] });
    expect(screen.getByText("Keine Personen im Zeitraum")).toBeTruthy();
    none.unmount();
    const vacation = renderWithTheme(VacationAbsenceTab, {
      vacation: {
        year: 2026,
        asOf: "2026-09-30",
        years: [{ year: 2026, asOf: "2026-09-30", rows: [] }],
      },
      absences: [],
      filterActive: false,
      loading: false,
      today: "2026-10-15",
      canNotify: false,
      periodLabel: "September 2026",
      personHref: () => null,
      onOpenPerson: () => {},
      onNotify: async () => ({ warned: 0, skippedDedup: 0 }),
    });
    expect(screen.getByText("Keine Personen im Zeitraum")).toBeTruthy();
    expect(screen.getByText("Keine Abwesenheiten im Zeitraum.")).toBeTruthy();
    vacation.unmount();
  });

  it("a caller who may export but read no report sees the bar and the short note (UI-SPEC no-rights case)", () => {
    expect(TEMPLATE).toContain("Keine Auswertung freigegeben – Exporte verfügbar");
  });
});

describe("/reports (Issue #612) - staggered reveal", () => {
  it("animates the bar wrapper, the KPI card and each section of the tabs, and re-keys none of them", () => {
    expect(COMPONENTS.PeriodBar).toContain('class="period-sticky card-animate"');
    expect(TEMPLATE).toMatch(/<Card animate>\s*<PeriodKpis/);
    expect(COMPONENTS.TimesAccountsTable).toContain('<section class="card-animate period-section"');
    expect(countOf(COMPONENTS.VacationAbsenceTab, "<Card animate>")).toBe(2);
    expect(COMPONENTS.TodayAttendance).toContain("<Card animate");
    // Data changes swap the content inside the blocks: nothing is keyed.
    expect(countOf(TEMPLATE, "{#key")).toBe(0);
    for (const name of COMPONENT_NAMES) {
      expect(COMPONENTS[name], name).not.toContain("{#key");
    }
  });

  it("mounted: both tab components emit .card-animate sections", () => {
    const vacation = renderWithTheme(VacationAbsenceTab, {
      vacation: null,
      absences: null,
      filterActive: false,
      loading: true,
      today: "2026-10-15",
      canNotify: false,
      periodLabel: "September 2026",
      personHref: () => null,
      onOpenPerson: () => {},
      onNotify: async () => ({ warned: 0, skippedDedup: 0 }),
    });
    expect(document.querySelectorAll("section.card.card-animate")).toHaveLength(2);
    vacation.unmount();
    const today = renderWithTheme(TodayAttendance, {
      attendance: null,
      loading: true,
      error: "",
      rejected: false,
      canAddTeamEntry: false,
      canRecordTeamAbsence: false,
    });
    expect(document.querySelectorAll("section.card.card-animate")).toHaveLength(1);
    today.unmount();
    renderWithTheme(TimesAccountsTable, { ...TABLE_PROPS, rows: [person("A")] });
    expect(screen.getByTestId("period-section").classList.contains("card-animate")).toBe(true);
  });
});

// Issue #714 - the page wiring of the Stammsalon view: additive pins, the no-sum pins above stay.
describe("/reports period area (Issue #714) - the salon viewpoint is wired, the page sums nothing", () => {
  it("hands the remainder count to the KPI card", () => {
    expect(TEMPLATE).toContain("withoutHomeSalonCount={period?.withoutHomeSalonCount ?? null}");
  });

  it("renders SalonWorkedSection once, inside the zeiten tab, only when the answer carries helpers", () => {
    expect(TEMPLATE.match(/<SalonWorkedSection/g)).toHaveLength(1);
    const zeiten = TEMPLATE.slice(
      TEMPLATE.indexOf('{#if activeTab === "zeiten"}'),
      TEMPLATE.indexOf('{:else if activeTab === "urlaub"}'),
    );
    expect(zeiten).toContain("<SalonWorkedSection");
    expect(zeiten).toContain("{#if period?.helpers !== undefined}");
    expect(zeiten).toContain("helpers={period.helpers}");
  });

  it("passes the server's total and reach, never a sum of its own", () => {
    expect(TEMPLATE).toContain("totalMinutes={period.kpis.salonWorkedMinutes ?? null}");
    expect(TEMPLATE).toContain("helpersReach={period.helpersReach ?? null}");
    expect(PAGE).not.toMatch(/salonWorkedMinutes[^\n]*\.reduce\(/);
    expect(PAGE).not.toMatch(/\.reduce\([^\n]*salonWorkedMinutes/);
  });
});

// Issue #542 CTX-5 / AC-542-7 — source pins of the salon filter on Berichte (/reports).
//
// Why source-read and not mounted: the page mounts charts and fires its requests on mount (the
// same wall `team-leave-salon-558.test.ts` documents). The rendering contract of the label is
// mounted in `lib/components/team/__tests__/SalonScopeLabel.test.ts`, the pure decisions in
// `lib/salons/__tests__/page-scope.test.ts`; this file proves the page uses them the way the
// decisions require. The blocks that must stay unfiltered are pinned in
// `salon-filter-exempt-pages-558.test.ts`.
//
// Three requests follow the header salon: today's attendance, the Saldenübersicht and the
// Monatsexport download. The § 9 hint of the Monatsexport card is deliberately NOT one of them
// (orchestrator amendment 1): `GET /reports/monthly` narrows by its own membership rule, which is
// not the export's person set, so a filtered hint could appear or vanish against the figures of
// the export. The unfiltered hint is a superset and may over-warn, which is the safe direction.
//
// Mutation proofs (Phase 542, 2026-10-17) — recorded here, not re-run by CI
//   M1 `withSalonId` removed from the attendance load → red: "[filter] loadTodayAttendance sends the salon"
//   M2 the filtered effect without the context gate → red: "[effect] the filtered loads wait for the salon context and rerun on a change"
//   M3 the DATEV download wrapped in `withSalonId` → red in salon-filter-exempt-pages-558.test.ts (block "DATEV download")
//   M4 a changed PDF label text → red: "[mirror] the labels equal the constants of the PDF"

import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, it, expect, vi } from "vitest";

// The page-scope module imports the api client, which pulls in the auth store and its localStorage
// bootstrap; a stand-in (as in page-scope.test.ts) keeps this file free of that.
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

import { PERSON_SALDO_NOT_SPLIT_LABEL, SALON_EXPORT_PERSONS_NOTE } from "$lib/salons/page-scope";

function readSource(relativeFromHere: string, relativeFromCwd: string): string {
  try {
    return readFileSync(fileURLToPath(new URL(relativeFromHere, import.meta.url)), "utf8");
  } catch {
    return readFileSync(resolve(process.cwd(), relativeFromCwd), "utf8");
  }
}

const PAGE = readSource(
  "../routes/(app)/reports/+page.svelte",
  "src/routes/(app)/reports/+page.svelte",
);
// Issue #612 (pin ledger rows 2 and 13): the attendance list and the exports live in components
// now; the notes, the badge and the calm states are pinned where their strings are.
const TODAY = readSource(
  "../lib/components/reports/TodayAttendance.svelte",
  "src/lib/components/reports/TodayAttendance.svelte",
);
const TODAY_TYPES = readSource(
  "../lib/reports/today-attendance.ts",
  "src/lib/reports/today-attendance.ts",
);
const EXPORT_DIALOG = readSource(
  "../lib/components/reports/ExportDialog.svelte",
  "src/lib/components/reports/ExportDialog.svelte",
);

/** The body of `[async ]function <name>(` up to its closing brace at the top level of the script. */
function functionBody(name: string): string {
  const start = PAGE.indexOf(`function ${name}(`);
  expect(start, `function ${name} not found`).toBeGreaterThan(-1);
  const end = PAGE.indexOf("\n  }\n", start);
  expect(end, `end of ${name} not found`).toBeGreaterThan(start);
  return PAGE.slice(start, end);
}

const EFFECT_HEAD = "$effect(() => {\n    if (!contextLoaded) return;";

/** The text of the salon reload effect. */
function salonEffectBody(): string {
  const at = PAGE.indexOf(EFFECT_HEAD);
  expect(at, "salon reload effect not found").toBeGreaterThan(-1);
  return PAGE.slice(at, PAGE.indexOf("\n  });", at));
}

describe("Issue #542 — Berichte follow the header salon", () => {
  it("[vacuity gate] the page source is loaded and still is Berichte", () => {
    // Issue #612: the page shrank when the list and the export cards moved out (measured 47 618
    // bytes after 612-06); the floor keeps the check non-vacuous.
    expect(PAGE.length).toBeGreaterThan(30_000);
    expect(PAGE).toContain("<TodayAttendance");
    expect(TODAY).toContain("Heutige Anwesenheit");
  });

  it("[decision] the page computes its salon only through salonPageFilter and names no raw selection", () => {
    expect(PAGE).toContain("const pageSalonId = $derived(salonPageFilter($salonContext));");
    expect(PAGE).toContain("const scopeLabel = $derived(salonScopeLabel($salonContext));");
    expect(PAGE).not.toContain("selectedSalonId(");
    expect(PAGE).not.toContain(".selection");
    // Every narrowing is a server request: no client-side salon comparison.
    expect(PAGE).not.toMatch(/\.salonId\s*===/);
  });

  it("[filter] loadTodayAttendance sends the salon", () => {
    expect(functionBody("loadTodayAttendance")).toContain(
      'withSalonId("/dashboard/today-attendance", pageSalonId)',
    );
  });

  it("[filter] loadOvertimeOverview sends the salon", () => {
    expect(functionBody("loadOvertimeOverview")).toContain(
      'withSalonId("/dashboard/overtime-overview", pageSalonId)',
    );
  });

  it("[filter] downloadMonthlyExport sends the salon around the Monatsexport path", () => {
    const body = functionBody("downloadMonthlyExport");
    expect(body).toContain("withSalonId(");
    expect(body).toContain("/reports/monthly-export/pdf?year=${year}&month=${month}");
    expect(body).toContain("pageSalonId");
  });

  it("[filter] downloadPeriodCsv sends the salon through the CSV path of the period", () => {
    const body = functionBody("downloadPeriodCsv");
    expect(body).toContain("periodCsvPath(urlState.from, urlState.to, pageSalonId)");
    expect(body).toContain("Zeiten-und-Konten_");
  });

  it("[hint] the § 9 hint of the Monatsexport stays unfiltered (amendment 1)", () => {
    const body = functionBody("loadExportSection9Note");
    expect(body).toContain("/reports/monthly?year=${year}&month=${month}");
    expect(body).not.toContain("withSalonId(");
    expect(body).not.toContain("pageSalonId");
  });

  it("[effect] the filtered loads wait for the salon context and rerun on a change", () => {
    const body = salonEffectBody();
    expect(body).toContain("void pageSalonId;");
    expect(body).toContain("untrack(");
    expect(body).toContain("loadTodayAttendance()");
    expect(body).toContain("loadOvertimeOverview()");
    // The leave overview and the carry-over warnings ignore the header salon.
    expect(body).not.toContain("loadLeaveOverview");
    expect(body).not.toContain("loadCarryoverAtRisk");
    expect(body).not.toContain("loadExportSection9Note");
  });

  // Issue #612 (pin ledger row 2): the leave overview and the carry-over load are gone. The
  // vacation table and the Verfall column come with the period answer and follow the salon by its
  // request (pinned in "Issue #612 - the period request follows the header salon" below and in
  // salon-filter-exempt-pages-558.test.ts); the notice route never sends a salon.
  it("[effect] no separate leave-overview or carry-over load is left anywhere in the page", () => {
    expect(PAGE).not.toContain("loadLeaveOverview");
    expect(PAGE).not.toContain("loadCarryoverAtRisk");
    expect(PAGE).not.toContain("/reports/leave-overview");
    expect(PAGE).not.toContain("/reports/carryover-at-risk");
  });

  it("[rejection] attendance, overview and export turn the one 404 into the calm state", () => {
    for (const name of [
      "loadTodayAttendance",
      "loadOvertimeOverview",
      "downloadMonthlyExport",
      "downloadPeriodCsv",
    ]) {
      expect(functionBody(name), name).toContain("isSalonFilterRejected(");
    }
    expect(PAGE).toContain("attendanceSalonRejected");
    expect(PAGE).toContain("overviewSalonRejected");
    expect(PAGE).toContain("exportSalonRejected");
    // Four places show the calm state (the period answer is the fourth, Issue #612): the page holds
    // the exited section and the period answer, the attendance tab and the export dialog one each.
    const calm = /<SalonScopeLabel label=\{null\} rejected=\{true\} \/>/g;
    expect(PAGE.match(calm)?.length).toBe(2);
    expect(TODAY.match(calm)?.length).toBe(1);
    expect(EXPORT_DIALOG.match(calm)?.length).toBe(1);
    expect(TODAY).toContain("{:else if rejected}");
    expect(EXPORT_DIALOG).toContain("{#if salonRejected}");
    expect(PAGE).toContain("rejected={attendanceSalonRejected}");
    expect(PAGE).toContain("salonRejected={exportSalonRejected}");
  });

  it("[rejection] downloadPdf throws an ApiError carrying the response status", () => {
    const body = functionBody("downloadPdf");
    expect(body).toMatch(/throw new ApiError\(\s*res\.status,/);
  });

  it("[label] one SalonScopeLabel names the area's salon", () => {
    expect(PAGE.match(/<SalonScopeLabel label=\{scopeLabel\} \/>/g)?.length).toBe(1);
  });

  it("[notes] the person-list and DATEV notes render only under a filter", () => {
    // Issue #612 (pin ledger rows 2 and 13): SALON_HOME_PERSONS_NOTE belonged to the removed overview
    // card and ALL_SALONS_BLOCK_NOTE to the removed leave-overview and carry-over cards (the vacation
    // tab follows the salon now, see VacationAbsenceTab.test.ts). The export notes moved into the
    // dialog and render under its `filterActive` flag, which the page sets from the page filter.
    for (const name of [
      "SALON_EXPORT_PERSONS_NOTE",
      "PERSON_SALDO_NOT_SPLIT_LABEL",
      "DATEV_ALL_SALONS_NOTE",
      "EXPORT_NO_STAMMSALON_NOTE",
      "SALON_CSV_PERSONS_NOTE", // Issue #714: the CSV block names whom the file lists
    ]) {
      expect(EXPORT_DIALOG, name).toContain(`{${name}}`);
    }
    expect(PAGE).toMatch(/<ExportDialog[^>]*filterActive=\{pageSalonId !== null\}/s);
    // Every note sits under a `filterActive` guard: none renders unconditionally. Three guards since
    // #714 (Monatsexport, DATEV, CSV block).
    const guards = EXPORT_DIALOG.match(/\{#if filterActive\}/g)?.length ?? 0;
    expect(guards).toBe(3);
  });

  it("[elsewhere] an attendance row with workedElsewhere shows the badge", () => {
    expect(TODAY_TYPES).toContain("workedElsewhere?: boolean");
    expect(TODAY).toContain("{#if row.workedElsewhere}");
    expect(TODAY).toMatch(/title="In einem anderen Salon gearbeitet"\s*>anderer Salon<\/span\s*>/);
  });
});

describe("Issue #542 — the page labels equal the PDF labels", () => {
  const PDF = readSource("../../../api/src/composition/pdf.ts", "../api/src/composition/pdf.ts");

  function quoted(name: string): string {
    const m = PDF.match(new RegExp(`export const ${name} = "([^"]+)";`));
    expect(m, `${name} not declared as a plain string constant in pdf.ts`).not.toBeNull();
    return (m as RegExpMatchArray)[1];
  }

  it("[vacuity gate] the API source is non-empty and declares both names", () => {
    expect(PDF.length).toBeGreaterThan(10_000);
    expect(PDF).toContain("EXPORT_SALON_PERSONS_LABEL");
    expect(PDF).toContain("PERSON_SALDO_NOT_SPLIT_LABEL");
  });

  it("[mirror] the labels equal the constants of the PDF", () => {
    expect(SALON_EXPORT_PERSONS_NOTE).toBe(quoted("EXPORT_SALON_PERSONS_LABEL"));
    expect(PERSON_SALDO_NOT_SPLIT_LABEL).toBe(quoted("PERSON_SALDO_NOT_SPLIT_LABEL"));
  });
});

// ── Issue #612: the period answer follows the header salon the same way (pin ledger row 2) ────────

describe("Issue #612 - the period request follows the header salon", () => {
  it("[filter] loadPeriod sends the salon through periodReportPath and nothing else", () => {
    const body = functionBody("loadPeriod");
    expect(body).toContain("periodReportPath(from, to, salon)");
    expect(PAGE).toContain("void loadPeriod(urlState.from, urlState.to, salon)");
    // The salon argument is the page filter, read inside the effect.
    expect(PAGE).toMatch(
      /const salon = pageSalonId;\s+const wanted = canReportRead && periodTabActive;/,
    );
  });

  it("[effect] the period load waits for the salon context and reruns on a change of period or salon", () => {
    const at = PAGE.indexOf("void loadPeriod(urlState.from, urlState.to, salon)");
    const head = PAGE.lastIndexOf("$effect(() => {", at);
    const body = PAGE.slice(head, at);
    expect(body).toContain("if (!contextLoaded) return;");
    expect(body).toContain("void periodKey;");
    expect(body).toContain("const salon = pageSalonId;");
    expect(body).toContain("untrack(");
  });

  it("[rejection] the period 404 is the calm state, never the server text", () => {
    const body = functionBody("loadPeriod");
    expect(body).toContain("isSalonFilterRejected(e)");
    expect(body).toContain("periodSalonRejected = true;");
    expect(PAGE).toContain("{:else if periodSalonRejected}");
  });

  it("[mirror] the URL carries the salon only while the page filter applies (P-10)", () => {
    // The mirror writes `current`, which is `pageSalonId` (null without a page filter).
    expect(PAGE).toContain("const current = pageSalonId;");
    expect(PAGE).toContain(
      "if (wanted !== current) writeState({ ...urlState, salonId: current });",
    );
    // An opened link may select only a salon of the caller's own context list (T-612-21).
    expect(PAGE).toContain("ctx.salons.some((salon) => salon.id === wanted)");
    expect(PAGE).toContain("showSalonOptions(ctx)");
    expect(PAGE).toContain("salonContext.setSelection(wanted);");
  });

  it("[notes] the person-saldo note and the page filter still decide the KPI callout", () => {
    expect(PAGE).toContain("filterActive={pageSalonId !== null}");
  });
});

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
    expect(PAGE.length).toBeGreaterThan(60_000);
    expect(PAGE).toContain("Heutige Anwesenheit");
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
    expect(body).toContain("/reports/monthly-export/pdf?year=${exportYear}&month=${exportMonth}");
    expect(body).toContain("pageSalonId");
  });

  it("[hint] the § 9 hint of the Monatsexport card stays unfiltered (amendment 1)", () => {
    const body = functionBody("loadExportSection9Note");
    expect(body).toContain("/reports/monthly?year=${exportYear}&month=${exportMonth}");
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
    for (const name of ["loadTodayAttendance", "loadOvertimeOverview", "downloadMonthlyExport"]) {
      expect(functionBody(name), name).toContain("isSalonFilterRejected(");
    }
    expect(PAGE).toContain("attendanceSalonRejected");
    expect(PAGE).toContain("overviewSalonRejected");
    expect(PAGE).toContain("exportSalonRejected");
    // Issue #612: the period answer is a fourth place that turns the one 404 into the calm state.
    expect(PAGE.match(/<SalonScopeLabel label=\{null\} rejected=\{true\} \/>/g)?.length).toBe(4);
  });

  it("[rejection] downloadPdf throws an ApiError carrying the response status", () => {
    const body = functionBody("downloadPdf");
    expect(body).toMatch(/throw new ApiError\(\s*res\.status,/);
  });

  it("[label] one SalonScopeLabel names the area's salon", () => {
    expect(PAGE.match(/<SalonScopeLabel label=\{scopeLabel\} \/>/g)?.length).toBe(1);
  });

  it("[notes] the person-list and all-salons notes render only under a filter", () => {
    expect(PAGE).toContain("{#if pageSalonId !== null}");
    // Issue #612 (pin ledger row 2): SALON_HOME_PERSONS_NOTE belonged to the removed overview card -
    // the period table shows no saldo under a filter (the KPI callout says why), so no
    // "Personen nach Stammsalon" line is left to pin.
    for (const name of [
      "SALON_EXPORT_PERSONS_NOTE",
      "PERSON_SALDO_NOT_SPLIT_LABEL",
      "DATEV_ALL_SALONS_NOTE",
      "EXPORT_NO_STAMMSALON_NOTE",
    ]) {
      expect(PAGE, name).toContain(`{${name}}`);
    }
    // Every use sits under a `pageSalonId !== null` guard: no note renders unconditionally.
    // Issue #612: ALL_SALONS_BLOCK_NOTE belonged to the removed leave-overview and carry-over cards
    // (the vacation tab follows the salon now, see VacationAbsenceTab.test.ts), so two guards remain.
    const guards = PAGE.match(/\{#if pageSalonId !== null\}/g)?.length ?? 0;
    expect(guards).toBeGreaterThanOrEqual(2);
  });

  it("[elsewhere] an attendance row with workedElsewhere shows the badge", () => {
    expect(PAGE).toContain("workedElsewhere?: boolean");
    expect(PAGE).toContain("{#if row.workedElsewhere}");
    expect(PAGE).toMatch(/title="In einem anderen Salon gearbeitet"\s*>anderer Salon<\/span\s*>/);
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

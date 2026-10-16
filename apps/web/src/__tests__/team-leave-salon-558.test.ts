// Issue #558 D-03/D-04/D-08/D-09 — source pins of the salon filter on Team-Anträge (/team/leave).
//
// Why source-read and not mounted: the page imports `$app/stores`, mounts a dozen dialogs and fires
// its requests on mount (the same wall `team-leave-attest-action.test.ts` documents). The rendering
// contract of the label is mounted in `lib/components/team/__tests__/SalonScopeLabel.test.ts`, the
// pure decisions in `lib/salons/__tests__/page-scope.test.ts`; this file proves the page uses them
// the way the decisions require. The two requests that must stay unfiltered (the review dialog's
// overlap check and /inbox) are pinned in `salon-filter-exempt-pages-558.test.ts`.
//
// Mutation proof (Phase 558, 2026-10-16) — recorded here, not re-run by CI
//   M1 the PENDING approval queue request built without withSalonId → red: "[filter] loadData sends the salon on the year list, the PENDING approval queue and the people list"
//   M2 the deep-link scroll run from onMount before the first load again → red: "[deep links] the scroll and highlight run after the first completed load, never from onMount"

import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, it, expect } from "vitest";

function readRouteFile(relativeFromHere: string, relativeFromCwd: string): string {
  try {
    return readFileSync(fileURLToPath(new URL(relativeFromHere, import.meta.url)), "utf8");
  } catch {
    return readFileSync(resolve(process.cwd(), relativeFromCwd), "utf8");
  }
}

const PAGE = readRouteFile(
  "../routes/(app)/team/leave/+page.svelte",
  "src/routes/(app)/team/leave/+page.svelte",
);

/** The body of `function <name>(` up to its closing brace at the top level of the script. */
function functionBody(name: string): string {
  const start = PAGE.indexOf(`function ${name}(`);
  expect(start, `function ${name} not found`).toBeGreaterThan(-1);
  const end = PAGE.indexOf("\n  }\n", start);
  expect(end, `end of ${name} not found`).toBeGreaterThan(start);
  return PAGE.slice(start, end);
}

/** The text of the page's `onMount(() => { ... });` block. */
function onMountBody(): string {
  const start = PAGE.indexOf("onMount(() => {");
  expect(start, "onMount not found").toBeGreaterThan(-1);
  return PAGE.slice(start, PAGE.indexOf("\n  });", start));
}

const EFFECT_HEAD = "$effect(() => {\n    if (!contextLoaded) return;";

/** The text of the salon reload effect. */
function salonEffectBody(): string {
  const at = PAGE.indexOf(EFFECT_HEAD);
  expect(at, "salon reload effect not found").toBeGreaterThan(-1);
  return PAGE.slice(at, PAGE.indexOf("\n  });", at));
}

describe("Issue #558 — Team-Anträge follow the header salon", () => {
  it("[vacuity gate] the page source is loaded and still is Team-Anträge", () => {
    expect(PAGE.length).toBeGreaterThan(60_000);
    expect(PAGE).toContain("Team-Anträge");
  });

  it("[filter] loadData sends the salon on the year list, the PENDING approval queue and the people list", () => {
    const body = functionBody("loadData");
    expect(body).toContain("withSalonId(`/leave/requests?year=${calYear}`, pageSalonId)");
    expect(body).toContain('withSalonId("/leave/requests?status=PENDING", pageSalonId)');
    expect(body).toContain('withSalonId("/employees", pageSalonId)');
    expect(PAGE).toContain("salonPageFilter($salonContext)");
  });

  it("[filter] the calendar, the § 9 list and the iCal download send the salon", () => {
    expect(functionBody("loadCalendar")).toContain(
      "withSalonId(`/leave/calendar?year=${calYear}&month=${calMonth}`, pageSalonId)",
    );
    expect(functionBody("loadSection9Cases")).toContain(
      'withSalonId("/leave/section9", pageSalonId)',
    );
    expect(functionBody("downloadIcal")).toContain(
      'withSalonId("/api/v1/leave/ical/team", pageSalonId)',
    );
  });

  it("[single-salon] the page never names the store's raw selection and never filters by salon itself", () => {
    expect(PAGE).not.toContain("selectedSalonId(");
    expect(PAGE).not.toContain(".selection");
    // Every narrowing is a server request (T-558-12): no client-side salon comparison.
    expect(PAGE).not.toMatch(/\.salonId\s*===/);
  });

  it("[reload] one effect on the loaded context and the salon runs the three loaders via untrack", () => {
    const effect = salonEffectBody();
    expect(effect).toContain("pageSalonId");
    expect(effect).toContain("untrack(");
    expect(effect).toContain("loadData()");
    expect(effect).toContain("loadCalendar()");
    expect(effect).toContain("loadSection9Cases()");
    expect(PAGE).toContain("const contextLoaded = $derived($salonContext.loaded)");
    expect(PAGE).toContain("const pageSalonId = $derived(salonPageFilter($salonContext))");
  });

  it("[order] each salon-carrying loader has its own generation counter checked after the await", () => {
    const loaders: [string, string, string, string][] = [
      ["loadData", "dataGeneration", "await Promise.all", "allTeamRequests = "],
      ["loadCalendar", "calendarGeneration", "await api.get", "calEntries = "],
      ["loadSection9Cases", "section9Generation", "await api.get", "section9Cases = "],
    ];
    for (const [fn, counter, awaitText, assign] of loaders) {
      const body = functionBody(fn);
      expect(PAGE, `${counter} declaration`).toContain(`let ${counter} = 0;`);
      expect(body, `${fn} increments`).toContain(`++${counter}`);
      const awaitAt = body.indexOf(awaitText);
      expect(awaitAt, `${fn} await`).toBeGreaterThan(-1);
      const check = body.indexOf(`generation !== ${counter}`, awaitAt);
      expect(check, `${fn} generation check after the await`).toBeGreaterThan(awaitAt);
      expect(body.indexOf(assign, awaitAt), `${fn} assigns after the check`).toBeGreaterThan(check);
    }
  });

  it("[404 calm] a rejected salon empties the three lists and shows the calm text: no error alert", () => {
    const body = functionBody("loadData");
    const catchAt = body.indexOf("catch (e: unknown)");
    expect(catchAt).toBeGreaterThan(-1);
    const rejected = body.indexOf("isSalonFilterRejected(e)", catchAt);
    expect(rejected).toBeGreaterThan(catchAt);
    const branch = body.slice(rejected, body.indexOf("} else {", rejected));
    expect(branch).toContain("salonRejected = true");
    expect(branch).toContain("allTeamRequests = []");
    expect(branch).toContain("pendingRequests = []");
    expect(branch).toContain("employees = []");
    expect(branch).not.toContain("error =");
    expect(branch).not.toContain("toasts.error");
    // Any other failure keeps today's handling.
    expect(body).toContain('error = e instanceof Error ? e.message : "Fehler beim Laden"');
    // The calendar and the § 9 list empty silently (they always did).
    expect(functionBody("loadCalendar")).toContain("calEntries = []");
    expect(functionBody("loadSection9Cases")).toContain("section9Cases = []");
  });

  it("[label once] the shared label is rendered exactly once, directly after the page head", () => {
    expect(PAGE.split("<SalonScopeLabel").length - 1).toBe(1);
    const label = "<SalonScopeLabel label={scopeLabel} rejected={salonRejected} />";
    const headEnd = PAGE.indexOf("</PageHead>");
    expect(headEnd).toBeGreaterThan(-1);
    expect(
      PAGE.slice(headEnd + "</PageHead>".length)
        .trimStart()
        .startsWith(label),
    ).toBe(true);
  });

  it("[deep links] the tab is chosen at once; the URL parameters are still read", () => {
    const body = onMountBody();
    expect(body).toContain('$page.url.searchParams.get("view") === "approvals"');
    expect(body).toContain('$page.url.searchParams.get("request")');
    expect(body).toContain('$page.url.searchParams.get("section9")');
    expect(body).toContain('view = "approvals"');
  });

  it("[deep links] the scroll and highlight run after the first completed load, never from onMount", () => {
    const mount = onMountBody();
    expect(mount).not.toContain("requestAnimationFrame(");
    expect(mount).not.toContain("setTimeout(");
    expect(mount).not.toContain("runDeepLink(");
    expect(mount).not.toContain("loadData()");
    const run = functionBody("runDeepLink");
    expect(run).toContain("requestAnimationFrame(");
    expect(run).toContain("scrollIntoView(");
    expect(run).toContain("`request-${");
    expect(run).toContain("`section9-${");
    expect(run).toContain("setTimeout(");
    const effect = salonEffectBody();
    const loaded = effect.indexOf("await loadData()");
    expect(loaded, "the effect awaits the first loadData").toBeGreaterThan(-1);
    expect(effect.indexOf("runDeepLink()", loaded)).toBeGreaterThan(loaded);
    // onMount registers the link before the effect can complete a load (effects run in order).
    expect(PAGE.indexOf("onMount(() => {")).toBeLessThan(PAGE.indexOf(EFFECT_HEAD));
  });

  it("[existing reloads] the write paths still call the same loaders", () => {
    expect(PAGE).toContain("await Promise.all([loadData(), loadCalendar(), loadSection9Cases()]);");
    expect(PAGE).toContain("await Promise.all([loadData(), loadCalendar()]);");
  });
});

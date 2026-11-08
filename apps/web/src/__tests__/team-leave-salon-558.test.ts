// Issue #558 D-03/D-04/D-08/D-09 — source pins of the salon filter on Team-Anträge (/team/leave).
//
// Why source-read and not mounted: the page imports `$app/stores`, mounts a dozen dialogs and fires
// its requests on mount (the same wall `team-leave-attest-action.test.ts` documents). The rendering
// contract of the label is mounted in `lib/components/team/__tests__/SalonScopeLabel.test.ts`, the
// pure decisions in `lib/salons/__tests__/page-scope.test.ts`; this file proves the page uses them
// the way the decisions require. The two requests that must stay unfiltered (the review dialog's
// overlap check and /inbox) are pinned in `salon-filter-exempt-pages-558.test.ts`.
//
// #840 amendments (plan 840-10, E-01/D-840-14/D-840-17): the page is now „Abwesenheiten“ with three
// tabs on the one timeline. The month grid and its `loadCalendar` are gone (the calendar read is the
// range form, `loadOverview`), the salon scope label is asserted ABSENT (no second salon display),
// the deep-link reads moved to `area-tabs.ts` and `+page.ts`, and the write paths reload through
// `reloadAll()`. The generation counters, the calm 404 and the `withSalonId` hygiene are kept.
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
  it("[vacuity gate] the page source is loaded and still is the team absence page", () => {
    expect(PAGE.length).toBeGreaterThan(60_000);
    expect(PAGE).toContain('title="Abwesenheiten"'); // #840 (E-01): formerly „Team-Anträge“
  });

  it("[filter] loadData sends the salon on the year list, the PENDING approval queue and the people list", () => {
    const body = functionBody("loadData");
    // #840: the list year follows the URL anchor day (`listYear`), no longer a page-local calYear.
    expect(body).toContain("withSalonId(`/leave/requests?year=${listYear}`, pageSalonId)");
    expect(body).toContain('withSalonId("/leave/requests?status=PENDING", pageSalonId)');
    expect(body).toContain('withSalonId("/employees", pageSalonId)');
    expect(PAGE).toContain("salonPageFilter($salonContext)");
  });

  it("[filter] the calendar and the iCal download send the salon; the § 9 loader left the page", () => {
    // #840 (D-840-07/14): the calendar is read in its range form by loadOverview.
    expect(functionBody("loadOverview")).toContain(
      "withSalonId(`/leave/calendar?${calendarRangeQuery(overviewPeriod)}`, pageSalonId)",
    );
    // #840 D-840-05: the § 9 cases moved to /inbox (unfiltered work queue, D-840-29); the page no
    // longer loads, filters or names them (pinned in inbox-section9-840.test.ts).
    expect(PAGE).not.toContain("loadSection9Cases");
    expect(PAGE).not.toContain("/leave/section9");
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

  it("[reload] one effect on the loaded context and the salon runs the page loaders via untrack", () => {
    const effect = salonEffectBody();
    expect(effect).toContain("pageSalonId");
    expect(effect).toContain("untrack(");
    expect(effect).toContain("loadData()");
    expect(effect).not.toContain("loadCalendar()"); // #840: the month grid is gone
    expect(effect).not.toContain("loadSection9Cases()"); // #840 D-840-05: moved to /inbox
    expect(PAGE).toContain("const contextLoaded = $derived($salonContext.loaded)");
    expect(PAGE).toContain("const pageSalonId = $derived(salonPageFilter($salonContext))");
  });

  it("[order] each salon-carrying loader has its own generation counter checked after the await", () => {
    const loaders: [string, string, string, string][] = [
      ["loadData", "dataGeneration", "await Promise.all", "allTeamRequests = "],
      // #840: the calendar loader is the range-form Übersicht loader (formerly loadCalendar).
      ["loadOverview", "overviewGeneration", "await api.get", "overviewRows = "],
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

  it("[404 calm] a rejected salon empties the lists and shows the calm text: no error alert", () => {
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
    // The calendar empties silently (it always did); the § 9 list left the page (#840 D-840-05).
    expect(functionBody("loadOverview")).toContain("overviewRows = []");
  });

  it("[no second salon display] the page renders no salon scope label (#840 D-840-14)", () => {
    // Formerly „label once“ (D-09): the header selection is the one salon display now, a rejected
    // salon only gets a calm sentence, so neither the component nor its helper is named at all.
    expect(PAGE).not.toContain("SalonScopeLabel");
    expect(PAGE).not.toContain("salonScopeLabel");
    expect(PAGE).toContain("salonRejected");
  });

  it("[deep links] the highlight target is read from the URL state; legacy links are mapped before the page", () => {
    // #840 (D-840-03): `?view=approvals`, `?section9=` and a bare `?request=` are redirected by
    // `+page.ts` through `teamLeaveRedirect` (pinned in team-leave-area-840.test.ts), so onMount no
    // longer picks a tab. It reads the request target from the parsed URL state, once.
    const body = onMountBody();
    expect(body).toContain("deepLinkRequestId = urlState.requestId");
    expect(body).not.toContain('get("view")');
    expect(body).not.toContain('view = "approvals"');
    // #840 D-840-05: ?section9=<id> is handled by /inbox.
    expect(body).not.toContain('$page.url.searchParams.get("section9")');
    expect(PAGE).toContain("parseTeamLeaveState($page.url.searchParams, today)");
  });

  it("[deep links] the scroll and highlight run after the first completed load, never from onMount", () => {
    const mount = onMountBody();
    expect(mount).not.toContain("requestAnimationFrame(");
    expect(mount).not.toContain("setTimeout(");
    expect(mount).not.toContain("runDeepLink(");
    expect(mount).not.toContain("loadData()");
    // #840: the scroll and highlight live in focusRequest (also used by a bar click); runDeepLink
    // reaches it through showLinkedRequest (review WR-05: the request may sit outside the year
    // list), and still only after the first completed load.
    const run = functionBody("runDeepLink");
    expect(run).toContain("showLinkedRequest(requestId)");
    expect(functionBody("showLinkedRequest")).toContain("focusRequest(requestId)");
    const focus = functionBody("focusRequest");
    expect(focus).toContain("requestAnimationFrame(");
    expect(focus).toContain("scrollIntoView(");
    expect(focus).toContain("`request-${");
    expect(focus).not.toContain("`section9-${"); // #840 D-840-05: the § 9 highlight moved to /inbox
    expect(focus).toContain("setTimeout(");
    const effect = salonEffectBody();
    const loaded = effect.indexOf("await loadData()");
    expect(loaded, "the effect awaits the first loadData").toBeGreaterThan(-1);
    expect(effect.indexOf("runDeepLink()", loaded)).toBeGreaterThan(loaded);
    // onMount registers the link before the effect can complete a load (effects run in order).
    expect(PAGE.indexOf("onMount(() => {")).toBeLessThan(PAGE.indexOf(EFFECT_HEAD));
  });

  it("[#840 Übersicht] the timeline loader sends the salon, has its own generation counter and empties calmly", () => {
    // #840 D-840-07: the Übersicht reads the range form of the calendar with the same #558 hygiene
    // the month grid had; the loader pins above stay unchanged.
    const body = functionBody("loadOverview");
    expect(body).toContain(
      "withSalonId(`/leave/calendar?${calendarRangeQuery(overviewPeriod)}`, pageSalonId)",
    );
    expect(PAGE).toContain("let overviewGeneration = 0;");
    expect(body).toContain("++overviewGeneration");
    const awaitAt = body.indexOf("await api.get");
    const check = body.indexOf("generation !== overviewGeneration", awaitAt);
    expect(check).toBeGreaterThan(awaitAt);
    expect(body.indexOf("overviewRows = timeline.rows", awaitAt)).toBeGreaterThan(check);
    expect(body).toContain("overviewRows = []");
    expect(body).not.toContain("toasts.error");
  });

  it("[#840 Übersicht] its own effect reruns the loader for a salon, a period or the tab", () => {
    const at = PAGE.indexOf('if (!contextLoaded || activeTab !== "uebersicht") return;');
    expect(at).toBeGreaterThan(-1);
    const effect = PAGE.slice(at, PAGE.indexOf("\n  });", at));
    expect(effect).toContain("pageSalonId");
    expect(effect).toContain("overviewKey");
    expect(effect).toContain("untrack(");
    expect(effect).toContain("loadOverview()");
  });

  it("[existing reloads] the write paths reload through the one reloadAll()", () => {
    // #840: formerly `Promise.all([loadData(), loadCalendar()])` at every write site.
    expect(PAGE).not.toContain("loadCalendar");
    expect(PAGE.split("await reloadAll();").length - 1).toBeGreaterThanOrEqual(3);
    const body = functionBody("reloadAll");
    expect(body).toContain("loadData()");
    expect(body).toContain("loadOverview()");
  });
});

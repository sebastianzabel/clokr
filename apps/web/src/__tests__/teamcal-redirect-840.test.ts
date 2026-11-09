// Issue #840 (plan 840-12; D-840-03, D-840-07, AC-1) - the old team calendar `/teamcal` is gone: its
// route is a redirect to the Übersicht tab of `/team/leave`, and every invariant the page carried is
// re-proven on its new home, the Übersicht loader of `routes/(app)/team/leave/+page.svelte`.
//
// This file replaces two deleted test files. Mapping (old pin -> new pin in this file):
//
//   teamcal-effective-statuses.test.ts (Issue #446, D-04)
//     [vacuity gate] page loaded, month grid          -> [vacuity gate] host page is loaded
//     imports/uses EFFECTIVE_LEAVE_STATUSES           -> [effective statuses] the calendar answer is the only
//                                                        leave source; the status rule is the server's, the
//                                                        mirror stays untouched
//     no `status=APPROVED` request URL                -> [effective statuses] no status-keyed request in the
//                                                        Übersicht loader, `status=APPROVED` nowhere
//   teamcal-salon-558.test.ts (Issue #558, D-03/D-04/D-08)
//     [vacuity gate]                                  -> [vacuity gate]
//     [filter] withSalonId from the page filter       -> [salon filter]
//     [single-salon] never the raw selection          -> [salon filter] (same test)
//     [reload] one effect, untrack, onMount none      -> [reload]
//     [order] generation guard after the await        -> [order]
//     [404 calm] empty grid, no error alert           -> [404 calm]
//     [label once] one SalonScopeLabel                -> replaced by design (D-840-14): the header selection is
//                                                        the one salon display, pinned as "no second salon
//                                                        display" in team-leave-salon-558.test.ts
//     [rejected empty state]                          -> [404 calm] (the calm sentence is the only text)
//   page-rights-538.test.ts "no role under a name"    -> moved to the team page there (E-01)
//
// Why source-read and not mounted: the page imports `$app/stores` and `$app/navigation` and fires its
// requests on mount (the wall `team-leave-salon-558.test.ts` documents). The redirect itself is a pure
// function, tested in `lib/leave/__tests__/area-tabs.test.ts`; the built-app probe is in the plan's
// verification.
//
// Mutation proof (Phase 840-12, `cp` backup/restore) - recorded here, not re-run by CI
//   M1 `redirect(307` -> `redirect(308` in teamcal/+page.ts          -> red: "[redirect] ..."
//   M2 the generation check after the await removed in loadOverview  -> red: "[order] ..."

import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, it, expect } from "vitest";

import { teamcalRedirect } from "$lib/leave/area-tabs";

function readRouteFile(relativeFromHere: string, relativeFromCwd: string): string {
  try {
    return readFileSync(fileURLToPath(new URL(relativeFromHere, import.meta.url)), "utf8");
  } catch {
    return readFileSync(resolve(process.cwd(), relativeFromCwd), "utf8");
  }
}

const TEAMCAL_DIR_FROM_HERE = "../routes/(app)/teamcal/";
const TEAMCAL_DIR_FROM_CWD = "src/routes/(app)/teamcal/";

const REDIRECT = readRouteFile(
  `${TEAMCAL_DIR_FROM_HERE}+page.ts`,
  `${TEAMCAL_DIR_FROM_CWD}+page.ts`,
);

const PAGE = readRouteFile(
  "../routes/(app)/team/leave/+page.svelte",
  "src/routes/(app)/team/leave/+page.svelte",
);

const MIRROR = readRouteFile(
  "../lib/leave/effective-leave-statuses.ts",
  "src/lib/leave/effective-leave-statuses.ts",
);

/** The body of `function <name>(` up to its closing brace at the top level of the script. */
function functionBody(name: string): string {
  const start = PAGE.indexOf(`function ${name}(`);
  expect(start, `function ${name} not found`).toBeGreaterThan(-1);
  const end = PAGE.indexOf("\n  }\n", start);
  expect(end, `end of ${name} not found`).toBeGreaterThan(start);
  return PAGE.slice(start, end);
}

/** The text of the `$effect` that owns the Übersicht load. */
function overviewEffectBody(): string {
  const at = PAGE.indexOf(
    '$effect(() => {\n    if (!contextLoaded || activeTab !== "uebersicht") return;',
  );
  expect(at, "Übersicht effect not found").toBeGreaterThan(-1);
  return PAGE.slice(at, PAGE.indexOf("\n  });", at));
}

/** The text of the page's first `onMount(() => { ... });` block. */
function onMountBody(): string {
  const start = PAGE.indexOf("onMount(() => {");
  expect(start, "onMount not found").toBeGreaterThan(-1);
  return PAGE.slice(start, PAGE.indexOf("\n  });", start));
}

describe("Issue #840 (D-840-03) - /teamcal redirects to the Übersicht", () => {
  it("[vacuity gate] the redirect route and the host page are loaded and are the right files", () => {
    expect(REDIRECT.length).toBeGreaterThan(300);
    expect(REDIRECT).toContain("export const load");
    expect(PAGE.length).toBeGreaterThan(60_000);
    expect(PAGE).toContain('<PageHead eyebrow="Team" title={pageLabel("/team/leave")}>');
  });

  it("[page gone] the old team calendar page does not exist any more", () => {
    // The sibling `+page.ts` was read above (so the directory resolves); the page file must be absent
    // next to it, whichever of the two path bases found the redirect.
    let dir: string;
    try {
      dir = fileURLToPath(new URL(TEAMCAL_DIR_FROM_HERE, import.meta.url));
      readFileSync(resolve(dir, "+page.ts"), "utf8");
    } catch {
      dir = resolve(process.cwd(), TEAMCAL_DIR_FROM_CWD);
      readFileSync(resolve(dir, "+page.ts"), "utf8");
    }
    expect(existsSync(resolve(dir, "+page.svelte"))).toBe(false);
  });

  it("[redirect] +page.ts redirects with a 307 to a target built only by teamcalRedirect", () => {
    expect(REDIRECT).toContain("redirect(307, teamcalRedirect(url.searchParams))");
    expect(REDIRECT).toContain('from "$lib/leave/area-tabs"');
    // The target is never assembled from the URL here (T-840-38, open redirect).
    expect(REDIRECT).not.toContain("searchParams.get(");
    expect(REDIRECT).not.toContain("url.pathname");
  });

  it("[redirect] the target is the fixed Übersicht at month zoom, with only whitelisted parameters", () => {
    expect(teamcalRedirect(new URLSearchParams())).toBe("/team/leave?tab=uebersicht&zoom=monat");
    const carried = teamcalRedirect(
      new URLSearchParams(
        "salonId=3f2b6a0e-1c5d-4e7a-9b8c-0d1e2f3a4b5c&datum=2026-12-10&year=2026",
      ),
    );
    expect(carried.startsWith("/team/leave?")).toBe(true);
    expect(carried).toContain("tab=uebersicht");
    expect(carried).toContain("zoom=monat");
    // A hostile value never reaches the target.
    const hostile = teamcalRedirect(
      new URLSearchParams("next=//evil.example&salonId=//evil.example&datum=javascript:1"),
    );
    expect(hostile.startsWith("/team/leave?")).toBe(true);
    expect(hostile).not.toContain("evil");
    expect(hostile).not.toContain("javascript");
  });
});

describe("Issue #446 (D-04), re-proven on the Übersicht - effective statuses", () => {
  it("[effective statuses] the calendar answer is the only leave source of the Übersicht loader", () => {
    const body = functionBody("loadOverview");
    expect(body).toContain("/leave/calendar?");
    // No status-keyed request list is read here: the status rule (PENDING plus the effective
    // statuses) is the server's, the page draws what it is given.
    expect(body).not.toContain("/leave/requests");
    expect(body).not.toContain("status=");
    expect(PAGE).not.toContain("status=APPROVED");
  });

  it("[effective statuses] the display mirror of the effective statuses is untouched", () => {
    expect(MIRROR).toContain(
      'export const EFFECTIVE_LEAVE_STATUSES = ["APPROVED", "CANCELLATION_REQUESTED"] as const;',
    );
    expect(MIRROR).toContain("export function isEffectiveLeaveStatus(");
  });
});

describe("Issue #558 (D-03/D-04/D-08), re-proven on the Übersicht - the header salon", () => {
  it("[salon filter] the calendar read is built by withSalonId from the page filter, never the raw selection", () => {
    expect(functionBody("loadOverview")).toContain(
      "withSalonId(`/leave/calendar?${calendarRangeQuery(overviewPeriod)}`, pageSalonId)",
    );
    expect(PAGE).toContain("const pageSalonId = $derived(salonPageFilter($salonContext))");
    expect(PAGE).not.toContain("selectedSalonId(");
    expect(PAGE).not.toContain(".selection");
    // Every narrowing is a server request: no client-side salon comparison.
    expect(PAGE).not.toMatch(/\.salonId\s*===/);
  });

  it("[reload] one effect on the loaded context, the salon and the period owns the load; onMount starts none", () => {
    const effect = overviewEffectBody();
    expect(effect).toContain("pageSalonId");
    expect(effect).toContain("overviewKey");
    expect(effect).toContain("untrack(");
    expect(effect).toContain("loadOverview()");
    expect(PAGE).toContain("const contextLoaded = $derived($salonContext.loaded)");
    const mount = onMountBody();
    expect(mount).not.toContain("loadOverview(");
    expect(mount).not.toContain("loadData(");
  });

  it("[order] a response of an older load never overwrites a newer one", () => {
    const body = functionBody("loadOverview");
    expect(PAGE).toContain("let overviewGeneration = 0;");
    expect(body).toContain("++overviewGeneration");
    const awaitAt = body.indexOf("await api.get");
    expect(awaitAt).toBeGreaterThan(-1);
    const check = body.indexOf("generation !== overviewGeneration", awaitAt);
    expect(check, "generation check after the await").toBeGreaterThan(awaitAt);
    expect(body.indexOf("overviewRows = ", awaitAt)).toBeGreaterThan(check);
    // The error path is guarded the same way, and the loading flag is cleared only by the latest load.
    expect(
      body.indexOf("generation !== overviewGeneration", body.indexOf("catch")),
    ).toBeGreaterThan(-1);
    expect(body).toContain("if (generation === overviewGeneration) overviewLoading = false");
  });

  it("[404 calm] a rejected salon or any failed read empties the view and raises no error alert", () => {
    const body = functionBody("loadOverview");
    const catchAt = body.indexOf("catch {");
    expect(catchAt).toBeGreaterThan(-1);
    const branch = body.slice(catchAt, body.indexOf("} finally", catchAt));
    expect(branch).toContain("overviewRows = []");
    expect(branch).toContain("overviewHolidays = []");
    expect(branch).toContain("overviewSalons = []");
    expect(branch).not.toContain("error =");
    expect(branch).not.toContain("toasts.error");
    // The list loader names the rejected salon with a calm sentence, not an alert.
    const data = functionBody("loadData");
    const rejected = data.indexOf("isSalonFilterRejected(e)");
    expect(rejected).toBeGreaterThan(-1);
    expect(data.slice(rejected, data.indexOf("} else {", rejected))).toContain(
      "salonRejected = true",
    );
    expect(PAGE).toContain('data-testid="leave-team-salon-unavailable"');
  });

  it("[no role under a name] the Übersicht page and its timeline never print a person's role", () => {
    const timeline = readRouteFile(
      "../lib/components/leave/timeline/AbsenceTimeline.svelte",
      "src/lib/components/leave/timeline/AbsenceTimeline.svelte",
    );
    expect(timeline.length).toBeGreaterThan(2_000);
    for (const src of [PAGE, timeline]) {
      expect(src).not.toMatch(/\bu\.role\b/);
      expect(src).not.toMatch(/\buser\??\.role\b/);
    }
  });
});

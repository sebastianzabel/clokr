// Issue #840 (D-840-05, D-840-29, E-02) - source pins: the § 9 cases wait in the inbox.
//
// Why source-read and not mounted: both pages import `$app/*`, mount several dialogs and fire their
// requests on mount (the same wall `team-leave-salon-558.test.ts` documents). The pure decisions
// live in `lib/leave/__tests__/inbox-deep-link.test.ts` and `lib/nav/__tests__/team-nav.test.ts`.

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

const INBOX = readRouteFile(
  "../routes/(app)/inbox/+page.svelte",
  "src/routes/(app)/inbox/+page.svelte",
);
const TEAM_LEAVE = readRouteFile(
  "../routes/(app)/team/leave/+page.svelte",
  "src/routes/(app)/team/leave/+page.svelte",
);

/** The body of `async function <name>(` / `function <name>(` up to its closing brace. */
function functionBody(source: string, name: string): string {
  const start = source.search(new RegExp(`(async )?function ${name}\\(`));
  expect(start, `function ${name} not found`).toBeGreaterThan(-1);
  const end = source.indexOf("\n  }\n", start);
  expect(end, `end of ${name} not found`).toBeGreaterThan(start);
  return source.slice(start, end);
}

/** The text of the page's `onMount(() => { ... });` block. */
function onMountBody(source: string): string {
  const start = source.indexOf("onMount(() => {");
  expect(start, "onMount not found").toBeGreaterThan(-1);
  return source.slice(start, source.indexOf("\n  });", start));
}

describe("Issue #840 D-840-05 - the § 9 cases wait in the inbox", () => {
  it("[vacuity gate] both page sources are loaded and are still the pages they claim to be", () => {
    expect(INBOX.length).toBeGreaterThan(10_000);
    expect(INBOX).toContain("Inbox");
    expect(TEAM_LEAVE.length).toBeGreaterThan(60_000);
    expect(TEAM_LEAVE).toContain("Team-Anträge");
  });

  it("[section] the inbox renders a section „§ 9-Fälle“ with the three actions", () => {
    expect(INBOX).toContain('title="§ 9-Fälle"');
    expect(INBOX).toContain('data-testid="section9-cases-list"');
    expect(INBOX).toContain("AU liegt vor");
    expect(INBOX).toContain("Wieder eröffnen");
    expect(INBOX).toContain("section9-case-${c.id}-confirm");
    expect(INBOX).toContain("section9-case-${c.id}-reject");
    expect(INBOX).toContain("section9-case-${c.id}-reopen");
  });

  it("[loader] the inbox reads /leave/section9 without a salon parameter and with a generation guard", () => {
    const body = functionBody(INBOX, "loadSection9Cases");
    expect(body).toContain('api.get<Section9Case[]>("/leave/section9")');
    expect(body).not.toContain("salonId");
    expect(body).toContain("++section9Generation");
    const awaitAt = body.indexOf("await api.get");
    const check = body.indexOf("generation !== section9Generation", awaitAt);
    expect(check).toBeGreaterThan(awaitAt);
    expect(body.indexOf("section9Cases = cases", awaitAt)).toBeGreaterThan(check);
    // 403/404 empties calmly: no error alert, no toast.
    expect(body).toContain("section9Cases = []");
    expect(body).not.toContain("toasts.error");
    expect(body).not.toContain("error =");
  });

  it("[endpoints] confirm, reject, reopen and the paper upload keep their API calls", () => {
    expect(INBOX).toContain("`/leave/section9/${section9ConfirmCase.id}/confirm`");
    expect(INBOX).toContain("`/leave/section9/${section9RejectCase.id}/reject`");
    expect(INBOX).toContain("`/leave/section9/${c.id}/reopen`");
    expect(INBOX).toContain("`/section9-documents/${creditId}`");
    // The upload runs before the confirm call (T-104-10-PARTIAL).
    const submit = functionBody(INBOX, "submitSection9Confirm");
    expect(submit.indexOf("uploadSection9Document(")).toBeGreaterThan(-1);
    expect(submit.indexOf("uploadSection9Document(")).toBeLessThan(submit.indexOf("/confirm`"));
  });

  it("[hint] the section shows for holders of a § 9 key and the loader runs only then", () => {
    expect(INBOX).toContain('"section9:read:ZUGEWIESEN"');
    expect(INBOX).toContain("{#if canSection9}");
    const mount = onMountBody(INBOX);
    expect(mount).toContain("if (canSection9) loads.push(loadSection9Cases());");
    expect(mount).toContain("else section9Loading = false;");
  });

  it("[gone] /team/leave no longer loads, renders or deep-links the § 9 cases", () => {
    expect(TEAM_LEAVE).not.toContain("/leave/section9");
    expect(TEAM_LEAVE).not.toContain("loadSection9Cases");
    expect(TEAM_LEAVE).not.toContain("Section9Case");
    expect(TEAM_LEAVE).not.toContain("section9-cases-list");
    expect(TEAM_LEAVE).not.toContain('searchParams.get("section9")');
  });
});

describe("Issue #840 D-840-29 - the gate admits § 9 deciders", () => {
  it("[#558] the inbox stays an unfiltered page: no salon-filter helper is named, not even in a comment", () => {
    expect(INBOX).not.toContain("salonPageFilter");
    expect(INBOX).not.toContain("withSalonId(");
    expect(INBOX).not.toContain("SalonScopeLabel");
  });
});

describe("Issue #840 D-840-29 - the gate admits § 9 deciders", () => {
  it("[gate] the page gate in onMount lists all three decide keys", () => {
    const mount = onMountBody(INBOX);
    const gate = mount.slice(0, mount.indexOf('void goto("/dashboard")'));
    expect(gate).toContain('"leave-request:approve:ZUGEWIESEN"');
    expect(gate).toContain('"retro-request:approve:ZUGEWIESEN"');
    expect(gate).toContain('"section9:decide:ZUGEWIESEN"');
  });

  it("[gate] a role that only decides § 9 cases does not load the leave list (no 403 alert)", () => {
    const mount = onMountBody(INBOX);
    expect(mount).toContain(
      'hasAnyPermission($authStore.user, ["leave-request:approve:ZUGEWIESEN"])',
    );
    expect(mount).toContain("loads.push(loadRequests())");
    expect(mount).toContain("loading = false;");
  });
});

describe("Issue #840 D-840-05 - inbox deep links", () => {
  it("[read once] the link is parsed once in onMount through the pure parser", () => {
    expect(INBOX).toContain('from "$lib/leave/inbox-deep-link"');
    expect(INBOX.split("parseInboxDeepLink(").length - 1).toBe(1);
    expect(onMountBody(INBOX)).toContain("parseInboxDeepLink($page.url.searchParams, currentYear)");
  });

  it("[apply] it runs after the first completed loads, never before", () => {
    const mount = onMountBody(INBOX);
    const loaded = mount.indexOf("await Promise.all(loads)");
    expect(loaded).toBeGreaterThan(-1);
    expect(mount.indexOf("await applyDeepLink(link)")).toBeGreaterThan(loaded);
  });

  it("[request] opens the EXISTING review dialog for a row of the caller's own list", () => {
    const body = functionBody(INBOX, "applyDeepLink");
    expect(body).toContain("requests.find((r) => r.id === link.requestId)");
    expect(body).toContain("openDetail(found)");
    expect(INBOX).toContain("<LeaveReviewDialog");
    expect(body).toContain("Dieser Antrag ist nicht mehr offen oder nicht in deiner Reichweite.");
  });

  it("[year] another year's list is read once for the lookup only, and only for a differing year", () => {
    const body = functionBody(INBOX, "applyDeepLink");
    expect(body).toContain("link.year !== null && link.year !== currentYear");
    expect(body).toContain("findRequestInYear(link.requestId, link.year)");
    const lookup = functionBody(INBOX, "findRequestInYear");
    expect(lookup).toContain("`/leave/requests?year=${year}`");
    // The lookup never replaces the page's own list.
    expect(lookup).not.toContain("requests =");
  });

  it("[section9] scrolls to and highlights the case, then lets the highlight fade", () => {
    const body = functionBody(INBOX, "applyDeepLink");
    expect(body).toContain("highlightSection9Id = id");
    expect(body).toContain("`section9-${id}`");
    expect(body).toContain("scrollIntoView(");
    expect(body).toContain("setTimeout(");
  });

  it("[strip] the parameters leave the address bar with replaceState after use", () => {
    expect(INBOX).toContain('const DEEP_LINK_PARAMS = ["request", "year", "section9"] as const;');
    const strip = functionBody(INBOX, "stripDeepLinkParams");
    expect(strip).toContain("url.searchParams.delete(name)");
    expect(strip).toContain("replaceState(url, {})");
    expect(onMountBody(INBOX)).toContain("stripDeepLinkParams()");
  });
});

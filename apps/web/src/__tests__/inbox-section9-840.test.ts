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
    expect(onMountBody(INBOX)).toContain("if (canSection9) void loadSection9Cases();");
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

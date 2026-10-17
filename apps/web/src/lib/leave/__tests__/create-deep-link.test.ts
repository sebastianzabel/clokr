// Issue #587 (D-587-4, T-587-09) — the receiver of the „Abwesenheit erfassen“ link on
// /team/leave. URL parameters are untrusted text: the parser reduces them to a plain
// { employeeId, date } and the page only OPENS the existing dialog with them.
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, it, expect } from "vitest";

import { parseLeaveCreateDeepLink } from "../create-deep-link";

const ID = "3f2b8c1e-9a4d-4e6f-8b7a-1c2d3e4f5a6b";

function params(query: string): URLSearchParams {
  return new URLSearchParams(query);
}

describe("parseLeaveCreateDeepLink", () => {
  it("accepts create=1 with a valid uuid and a real day (id lowercased)", () => {
    expect(
      parseLeaveCreateDeepLink(params(`create=1&employeeId=${ID.toUpperCase()}&date=2026-06-17`)),
    ).toEqual({ employeeId: ID, date: "2026-06-17" });
  });

  it("returns null without create=1", () => {
    expect(parseLeaveCreateDeepLink(params(`employeeId=${ID}&date=2026-06-17`))).toBeNull();
    expect(
      parseLeaveCreateDeepLink(params(`create=0&employeeId=${ID}&date=2026-06-17`)),
    ).toBeNull();
    expect(parseLeaveCreateDeepLink(params(`create=true&employeeId=${ID}`))).toBeNull();
    expect(parseLeaveCreateDeepLink(params(""))).toBeNull();
  });

  it("keeps the day and drops an invalid person (the picker opens empty)", () => {
    expect(parseLeaveCreateDeepLink(params("create=1&employeeId=abc&date=2026-06-17"))).toEqual({
      employeeId: null,
      date: "2026-06-17",
    });
    expect(parseLeaveCreateDeepLink(params("create=1&date=2026-06-17"))).toEqual({
      employeeId: null,
      date: "2026-06-17",
    });
  });

  it("keeps the person and drops an unreal or missing day (the dialog keeps its default)", () => {
    expect(parseLeaveCreateDeepLink(params(`create=1&employeeId=${ID}&date=2026-02-30`))).toEqual({
      employeeId: ID,
      date: null,
    });
    expect(parseLeaveCreateDeepLink(params(`create=1&employeeId=${ID}`))).toEqual({
      employeeId: ID,
      date: null,
    });
  });

  it("opens with nothing prefilled when both are unusable", () => {
    expect(parseLeaveCreateDeepLink(params("create=1&employeeId=x&date=y"))).toEqual({
      employeeId: null,
      date: null,
    });
    expect(parseLeaveCreateDeepLink(params("create=1"))).toEqual({ employeeId: null, date: null });
  });
});

// ── source pin of the page wiring ───────────────────────────────────────────────────────────
// The page imports `$app/*` and fires several API calls on mount, so it is read as source (same
// idiom as dashboard-team-salon-filter-84.test.ts).
function readRouteFile(relativeFromHere: string, relativeFromCwd: string): string {
  try {
    return readFileSync(fileURLToPath(new URL(relativeFromHere, import.meta.url)), "utf8");
  } catch {
    return readFileSync(resolve(process.cwd(), relativeFromCwd), "utf8");
  }
}

const PAGE = readRouteFile(
  "../../../routes/(app)/team/leave/+page.svelte",
  "src/routes/(app)/team/leave/+page.svelte",
);

function runDeepLinkBody(): string {
  const start = PAGE.indexOf("function runDeepLink(");
  expect(start, "runDeepLink not found").toBeGreaterThan(-1);
  const end = PAGE.indexOf("\n  onMount(", start);
  expect(end, "end of runDeepLink not found").toBeGreaterThan(start);
  return PAGE.slice(start, end);
}

describe("Issue #587 — the team leave page opens the existing dialog from the deep link", () => {
  it("imports the parser and reads it in onMount", () => {
    expect(PAGE).toContain("parseLeaveCreateDeepLink");
    const onMount = PAGE.slice(PAGE.indexOf("onMount(() => {"));
    expect(onMount).toContain("parseLeaveCreateDeepLink($page.url.searchParams)");
  });

  it("applies it inside runDeepLink (after the first list load), permission-checked", () => {
    const body = runDeepLinkBody();
    expect(body).toContain("deepLinkCreate");
    expect(body).toContain('hasPermission($authStore.user, "leave-request:create:ZUGEWIESEN")');
    expect(body).toContain("createModalOpen = true");
  });

  it("assigns the person only when it is in the page's own list", () => {
    const body = runDeepLinkBody();
    expect(body).toMatch(/employees\.(find|some)\(/);
    expect(body).toContain("createEmployeeId");
  });

  it("never submits from the deep-link path", () => {
    const body = runDeepLinkBody();
    expect(body).not.toMatch(/api\.(post|put|patch|delete)\(/);
    expect(body).not.toMatch(/\b(submit|save|create)\w*\(/i);
  });
});

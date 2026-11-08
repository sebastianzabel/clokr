// Issue #840 (E-02) - source pins: the inbox „Offen“ tab lists EVERY open leave request in the
// caller's approve reach, whatever year it starts in (a request for next January must not be
// missing from the only approval place). The API half is proven by
// `apps/api/src/__tests__/leave-requests-pending-all-years-840.test.ts`.
//
// Source-read for the same reason as `inbox-section9-840.test.ts`: the page imports `$app/*` and
// fires its requests on mount.

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

function functionBody(source: string, name: string): string {
  const start = source.search(new RegExp(`(async )?function ${name}\\(`));
  expect(start, `function ${name} not found`).toBeGreaterThan(-1);
  const end = source.indexOf("\n  }\n", start);
  expect(end, `end of ${name} not found`).toBeGreaterThan(start);
  return source.slice(start, end);
}

describe("Issue #840 E-02 - the Offen tab is not bound to the current year", () => {
  it("[vacuity gate] the inbox source is loaded", () => {
    expect(INBOX.length).toBeGreaterThan(10_000);
    expect(INBOX).toContain("loadRequests");
  });

  it("[load] the open list is read without a year, next to the year-bound list", () => {
    const body = functionBody(INBOX, "loadRequests");
    expect(body).toContain("`/leave/requests?year=${currentYear}`");
    expect(body).toContain('"/leave/requests?status=PENDING"');
    // The open read must carry no `year` (the year-bound read is the other one).
    const openRead = body.match(
      /api\.get<LeaveRequest\[\]>\(\s*("\/leave\/requests\?status=PENDING")/,
    );
    expect(openRead, "open read not found").not.toBeNull();
    expect(openRead![1]).not.toContain("year");
    expect(body).toContain("pendingRequests = openList");
  });

  it("[derive] „Offen“ and its badge/KPI come from the all-years list, the other tabs stay year-bound", () => {
    expect(INBOX).toMatch(/let openRequests = \$derived\(\s*pendingRequests\.filter\(/);
    expect(INBOX).toContain('requests.filter((r) => r.status === "APPROVED")');
    expect(INBOX).toContain('requests.filter((r) => r.status === "REJECTED")');
    expect(INBOX).toContain('if (tab === "open") return openRequests;');
  });

  it("[reload] a decision reloads both lists through the one loader", () => {
    expect(INBOX).toContain("onReviewed={loadRequests}");
    expect(INBOX.split("api.get<LeaveRequest[]>(").length - 1).toBe(
      // loadRequests (2 reads) + findRequestInYear (1 read)
      3,
    );
  });

  it("[deep link] a request id is looked up in the open list first", () => {
    const body = functionBody(INBOX, "applyDeepLink");
    expect(body.indexOf("pendingRequests.find(")).toBeGreaterThan(-1);
    expect(body.indexOf("pendingRequests.find(")).toBeLessThan(body.indexOf("requests.find("));
  });

  it("[#558] the inbox stays an unfiltered page", () => {
    expect(INBOX).not.toContain("salonPageFilter");
    expect(INBOX).not.toContain("withSalonId(");
    expect(INBOX).not.toContain("SalonScopeLabel");
  });
});

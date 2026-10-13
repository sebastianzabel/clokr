// Issue #85 D-09 / D-14 / D-15 — source pins of the Salonansicht wiring on `/team/time-entries`.
//
// Why source-read and not mounted: the page imports `$app/*` and fires a dozen requests in
// `onMount` (same wall as dashboard-team-salon-filter-84.test.ts documents). The rendering contract
// is mounted in `lib/components/team/__tests__/SalonTimeEntries.test.ts`, the grouping in
// `lib/team/__tests__/salon-time-entries.test.ts`; this file only proves the page uses them the
// way the decisions require.
//
// Mutation proofs (cp backup/restore of the page, 2026-10-13):
//   M1 `selectedSalonId(` added to the page      -> "[D-09] the salon comes only from
//      teamSalonViewSalon($salonContext) ..." red.
//   M2 `toasts.error(...)` added to the 404 branch -> "[calm 404] a rejected salon ... no toast, no
//      console.error" red.

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
  "../routes/(app)/team/time-entries/+page.svelte",
  "src/routes/(app)/team/time-entries/+page.svelte",
);

/** The body of `function <name>(` up to the next top-level function or section comment. */
function functionBody(name: string): string {
  const start = PAGE.indexOf(`function ${name}(`);
  expect(start, `function ${name} not found`).toBeGreaterThan(-1);
  const next = PAGE.slice(start + 1).search(/\n {2}(?:async )?function |\n {2}\/\/ ──/);
  expect(next, `end of ${name} not found`).toBeGreaterThan(-1);
  return PAGE.slice(start, start + 1 + next);
}

describe("Issue #85 — the Salonansicht of /team/time-entries", () => {
  // Anti-vacuity (CLAUDE.md § Anti-vacuity gate): every containment assertion below is trivially
  // true against an empty string, and the person view must still be there.
  it("[vacuity gate] the page source is loaded and still carries the person view", () => {
    expect(PAGE.length).toBeGreaterThan(50_000);
    expect(PAGE).toContain('aria-label="Mitarbeiter suchen"');
    expect(PAGE).toContain("Personenansicht");
    expect(PAGE).toContain("Salonansicht");
  });

  it("[D-09] the salon comes only from teamSalonViewSalon($salonContext), never the raw selection getter", () => {
    expect(PAGE).toContain("teamSalonViewSalon($salonContext)");
    expect(PAGE).not.toContain("selectedSalonId(");
  });

  it("[D-09] the request is built by salonViewRequestPath and no salon sends no request", () => {
    const body = functionBody("loadSalonView");
    expect(body).toContain("salonViewRequestPath(from, to, salonId)");
    const noSalon = body.indexOf("salonId === null");
    const request = body.indexOf("api.get");
    expect(noSalon).toBeGreaterThan(-1);
    expect(request).toBeGreaterThan(noSalon);
    expect(body.slice(noSalon, request)).toContain('salonViewStatus = "prompt"');
    expect(body.slice(noSalon, request)).toContain("return;");
  });

  it("[D-09] an effect reloads on mode, loaded context, salon and month — via untrack", () => {
    const at = PAGE.indexOf('$effect(() => {\n    if (teamMode !== "salon"');
    expect(at, "salon view effect not found").toBeGreaterThan(-1);
    const effect = PAGE.slice(at, PAGE.indexOf("\n  });", at));
    expect(effect).toContain("$salonContext.loaded");
    expect(effect).toContain("salonViewSalonId");
    expect(effect).toContain("salonViewFrom");
    expect(effect).toContain("salonViewTo");
    expect(effect).toContain("untrack(");
    expect(effect).toContain("loadSalonView(");
  });

  it("[generation guard] a stale response is dropped before it is assigned", () => {
    const body = functionBody("loadSalonView");
    expect(body).toContain("const generation = ++salonViewGeneration;");
    const guard = body.indexOf("generation !== salonViewGeneration");
    const assign = body.indexOf("salonViewDays = groupSalonEntries(");
    expect(guard).toBeGreaterThan(-1);
    expect(assign).toBeGreaterThan(guard);
    // The catch branch is guarded as well, so a stale 404 cannot flip a newer selection.
    const catchAt = body.indexOf("} catch (err) {");
    expect(body.slice(catchAt)).toContain("generation !== salonViewGeneration");
  });

  it("[calm 404] a rejected salon is a calm state — no toast, no console.error", () => {
    const body = functionBody("loadSalonView");
    const at = body.indexOf("isTeamSalonRejected(err)");
    expect(at, "404 branch not found").toBeGreaterThan(-1);
    const rest = body.slice(at);
    const branch = rest.slice(0, rest.indexOf("return;"));
    expect(branch).toContain('salonViewStatus = "rejected"');
    expect(branch).not.toContain("toasts.");
    expect(branch).not.toContain("console.error");
  });

  it("[D-15] the 1000-row hint is derived from the response and passed on", () => {
    expect(functionBody("loadSalonView")).toContain("salonViewCapReached(rows)");
    expect(PAGE).toContain("capReached={salonViewCapHit}");
  });

  it("[D-14] a deep link to a person outside the employee list opens the Salonansicht", () => {
    const at = PAGE.indexOf("normalizeEmployeeIdParam($page.url.searchParams.get");
    expect(at, "deep-link block not found").toBeGreaterThan(-1);
    const block = PAGE.slice(at, PAGE.indexOf("// Without a (valid) employee link", at));
    expect(block).toContain("employees.find(");
    // A listed person keeps selectEmployee(linked) exactly as before ...
    expect(block).toContain("if (linked) await selectEmployee(linked);");
    // ... and only the unlisted one switches the mode.
    const elseAt = block.indexOf("else");
    expect(elseAt).toBeGreaterThan(block.indexOf("selectEmployee(linked)"));
    expect(block.slice(elseAt)).toContain('teamMode = "salon"');
  });
});

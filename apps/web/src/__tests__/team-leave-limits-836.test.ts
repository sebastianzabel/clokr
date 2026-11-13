// Issue #836 (plan 07) — source pins of the leave-limit wiring on Team-Anträge (/team/leave).
//
// Why source-read and not mounted: the page imports `$app/stores`, mounts a dozen dialogs and fires
// its requests on mount (the same wall `team-leave-salon-558.test.ts` documents). The pure decisions
// are mounted/unit-tested in `lib/leave-limits/__tests__/` and `lib/components/leave/__tests__/`;
// this file proves the page uses them the way the decisions require.
//
// #840 amendments (plan 840-10, D-840-27): the limit marker no longer sits on a month-grid cell. It
// lives on the load row of the one timeline (`AbsenceTimeline`'s `load.exceeded`), fed by the same
// `GET /leave/limits/load` read over the period of the URL (Quartal and Monat; the endpoint answers
// at most 92 days, so the Jahr zoom draws no marker). The permission gate, the salon, the calm failure
// and the correction/exception tests are unchanged.
//
// Mutation proof (Phase 836, plan 07, 2026-11-06) — recorded here, not re-run by CI
//   M1 the early `if (!canReadLimitLoad)` return of loadLimitDays removed -> red: "[load] ..."
//   M2 `...pending.body` dropped from the resend in confirmLimitException -> red: "[correction] ..."

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

/** The body of `async function <name>(` up to its closing brace at the top level of the script. */
function functionBody(name: string): string {
  const start = PAGE.indexOf(`function ${name}(`);
  expect(start, `function ${name} not found`).toBeGreaterThan(-1);
  const end = PAGE.indexOf("\n  }\n", start);
  expect(end, `end of ${name} not found`).toBeGreaterThan(start);
  return PAGE.slice(start, end);
}

describe("Issue #836 — leave limits on Team-Anträge", () => {
  it("[vacuity gate] the page source is loaded and still is the team absence page", () => {
    expect(PAGE.length).toBeGreaterThan(60_000);
    expect(PAGE).toContain('title={pageLabel("/team/leave")}'); // #840 (E-01) / #574: „Abwesenheiten“
  });

  it("[load] the load is requested only for callers holding leave-limit:manage or leave-request:approve", () => {
    const gate = PAGE.indexOf("const canReadLimitLoad = $derived(");
    expect(gate).toBeGreaterThan(-1);
    const gateText = PAGE.slice(gate, PAGE.indexOf(");", gate));
    expect(gateText).toContain('"leave-limit:manage:ZUGEWIESEN"');
    expect(gateText).toContain('"leave-request:approve:ZUGEWIESEN"');

    const body = functionBody("loadLimitDays");
    expect(body.indexOf("if (!canReadLimitLoad)")).toBeGreaterThan(-1);
    expect(body.indexOf("if (!canReadLimitLoad)")).toBeLessThan(body.indexOf("api.get"));
    expect(PAGE.match(/leave\/limits\/load/g)).toHaveLength(1);
  });

  it("[load] the request carries the period of the URL (not the Jahr zoom) and the page salon", () => {
    const body = functionBody("loadLimitDays");
    expect(body).toContain("const { startDay: from, endDay: to } = overviewPeriod;");
    expect(body).toContain("withSalonId(`/leave/limits/load?from=${from}&to=${to}`, pageSalonId)");
    // The endpoint answers at most 92 days: a year is never asked for (and never guessed).
    const yearGuard = body.indexOf('overviewPeriod.zoom === "jahr"');
    expect(yearGuard).toBeGreaterThan(-1);
    expect(yearGuard).toBeLessThan(body.indexOf("api.get"));
  });

  it("[load] a failed load leaves no badge and raises no toast", () => {
    const body = functionBody("loadLimitDays");
    const catchAt = body.indexOf("} catch");
    expect(catchAt).toBeGreaterThan(-1);
    const catchText = body.slice(catchAt);
    expect(catchText).toContain("limitDays = new Map()");
    expect(catchText).not.toContain("toasts.");
    expect(catchText).not.toContain("error =");
  });

  it("[load] the load follows the timeline: loadOverview starts it", () => {
    expect(functionBody("loadOverview")).toContain("void loadLimitDays()");
  });

  it("[marker] the load row of the timeline gets the tooltip of every exceeded day, from the loaded map", () => {
    // #840 D-840-27: formerly a `cal-limit-badge` on a month-grid cell.
    const at = PAGE.indexOf("for (const [day, over] of limitDays)");
    expect(at).toBeGreaterThan(-1);
    const loop = PAGE.slice(at, at + 120);
    expect(loop).toContain("exceeded.set(day, limitBadgeTitle(over))");
    expect(PAGE).toContain("load={overviewLoad}");
    expect(PAGE).not.toContain("cal-limit-badge");
  });

  it("[correction] a 409 opens the exception ReasonDialog and the resend keeps the whole correction body", () => {
    const submit = functionBody("submitCorrection");
    expect(submit).toContain("isLeaveLimitExceptionRequired(e)");
    // The correction's own reason is mandatory and separate (checked before the request).
    expect(submit.indexOf("!correctReason.trim()")).toBeLessThan(submit.indexOf("api.patch"));
    expect(submit).toContain("reason: correctReason.trim()");
    expect(submit).toContain("pendingLimitCorrection = { id: requestId, body }");

    const confirm = functionBody("confirmLimitException");
    expect(confirm).toContain("validateExceptionReason(reason)");
    expect(confirm).toContain("...pending.body");
    expect(confirm).toContain("limitException: { reason: reason.trim() }");

    expect(PAGE).toContain('confirmLabel="Trotzdem korrigieren"');
    expect(PAGE).toContain('label="Begründung der Ausnahme"');
  });

  it("[warnings] the create form reports its warnings into the page notice", () => {
    expect(PAGE).toContain("limitSentences = warningSentences(result?.leaveLimitWarnings ?? [])");
    expect(PAGE).toContain("<LeaveLimitNotice sentences={limitSentences}");
  });

  it("[no counting] the page derives no limit figure of its own", () => {
    expect(PAGE).not.toMatch(/maxPersons|approvedBeforeRuleCount/);
  });
});

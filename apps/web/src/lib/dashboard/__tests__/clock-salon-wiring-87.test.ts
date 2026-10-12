// Issue #87 (D-06, D-13) — source-level wiring guard for the dashboard clock-in path.
//
// Why the checks are REGION-scoped: Phase 84 legitimately reads the #82 salon context elsewhere on
// the same page (the Team block). Only the clock-in path must never use it — the booked salon is
// the server's pattern salon or the employee's explicit pick, never the Topbar view filter.
// Why it reads the page SOURCE: no route page is mounted in this workspace (see
// dashboard-clock-card.test.ts for the precedent).
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

function readSource(url: URL, fallback: string): string {
  try {
    return readFileSync(fileURLToPath(url), "utf8");
  } catch {
    return readFileSync(resolve(process.cwd(), fallback), "utf8");
  }
}

const PAGE = readSource(
  new URL("../../../routes/(app)/dashboard/+page.svelte", import.meta.url),
  "src/routes/(app)/dashboard/+page.svelte",
);
const LIB = readSource(
  new URL("../clock-salon.ts", import.meta.url),
  "src/lib/dashboard/clock-salon.ts",
);
const COMPONENT = readSource(
  new URL("../../components/dashboard/ClockSalonSelect.svelte", import.meta.url),
  "src/lib/components/dashboard/ClockSalonSelect.svelte",
);

/** Source without whole-line comments, so prose about a forbidden name is not a violation. */
function code(text: string): string {
  return text
    .split("\n")
    .filter((line) => !/^\s*(\/\/|\/\*|\*|<!--)/.test(line))
    .join("\n");
}

/** From the marker to the next `async function` (exclusive); the marker must occur exactly once. */
function region(marker: string): string {
  const starts: number[] = [];
  let at = PAGE.indexOf(marker);
  while (at !== -1) {
    starts.push(at);
    at = PAGE.indexOf(marker, at + 1);
  }
  expect(starts, `marker "${marker}" must occur exactly once`).toHaveLength(1);
  const rest = PAGE.slice(starts[0] + marker.length);
  const next = rest.search(/\n\s*async function /);
  return marker + (next === -1 ? rest : rest.slice(0, next));
}

describe("clock salon wiring (Issue #87)", () => {
  it("performClockIn posts clockInBody() and never reads the #82 salon context or a null salon", () => {
    const body = code(region("async function performClockIn"));
    expect(body.length).toBeGreaterThan(200); // positive control: the region is not empty
    expect(body).toContain("clockInBody(");
    expect(body).not.toMatch(/salonContext|selectedSalonId|salonId:\s*null/);
  });

  it("the primary button is blocked via clockInBlocked() and still renders {primaryLabel}", () => {
    const at = PAGE.indexOf("onclick={handleClock}");
    expect(at).toBeGreaterThan(-1);
    const tag = PAGE.slice(at, PAGE.indexOf(">", PAGE.indexOf('type="button"', at)));
    expect(tag).toMatch(/disabled=\{[^}]*clockInBlocked\(/);
    expect(PAGE).toContain("{primaryLabel}");
  });

  it("the lib module and the selector component never import the #82 salon context", () => {
    for (const source of [LIB, COMPONENT]) {
      expect(source.length).toBeGreaterThan(100);
      // `selectedSalonId(` is the store's reader; a plain parameter of that name is unrelated.
      expect(code(source)).not.toMatch(/salon-context|salonContext|\bselectedSalonId\(/);
    }
  });

  it("the choice is loaded only inside the $effect keyed on dayKind, never by the poll", () => {
    const poll = code(region("async function pollDashboard"));
    expect(poll.length).toBeGreaterThan(100); // positive control
    expect(poll).not.toContain("loadClockSalonChoice");

    const calls = code(PAGE).match(/loadClockSalonChoice\(/g) ?? [];
    expect(calls).toHaveLength(1);
    const effectStart = PAGE.indexOf("$effect(() => {\n    void dayKind;");
    expect(effectStart).toBeGreaterThan(-1);
    const effect = PAGE.slice(effectStart, PAGE.indexOf("\n  });", effectStart));
    expect(effect).toContain("untrack(");
    expect(effect).toContain("loadClockSalonChoice(");
  });

  it("the confirmed re-clock-in still goes through performClockIn (so REOPEN gets no salon from the view)", () => {
    const reopen = code(region("async function confirmReopen"));
    expect(reopen).toContain("performClockIn()");
    expect(reopen).not.toMatch(/salonId/);
  });

  it("the clock card footer sets a light text colour, because the salon label and the booked-day note inherit it", () => {
    // Found in the visual check: .card-foot sets a muted grey that is unreadable on the dark card.
    const rule = PAGE.match(/:global\(\.timer-card-wrap \.timer-foot\)\s*\{[^}]*\}/);
    expect(rule, "the .timer-foot rule must exist").not.toBeNull();
    expect(rule![0]).toMatch(/\bcolor:\s*rgba\(255,\s*255,\s*255,/);
    // Positive control: the component really inherits instead of fixing its own colour.
    expect(COMPONENT).toMatch(/color:\s*inherit/);
  });
});

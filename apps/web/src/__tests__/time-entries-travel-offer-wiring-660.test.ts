// Issue #660 (D-05, D-07, AC-660-6) - wiring pins of the day-check travel offer on both
// time-entry pages.
//
// A source-read PIN, like the #92 wiring test: route pages cannot be mounted here (no `$app`
// alias in vitest). The pure decisions (the #64 gate, the label, the body, the error text) are
// proven in `lib/time-entries/__tests__/travel-entry-form.test.ts`, the button in
// `DayBreakPanel.test.ts`. What only a source scan proves is that each page hands the panel the
// offers ONLY through `travelOffersShown(dayCheck, multiEntryUi)`, sends the offer ONLY through
// `travelOfferPayload(` (so the body is the one trip body builder's), reports a refusal through
// `travelOfferErrorText(`, and never reads an offer field itself (T-660-08, T-660-09).

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

const PAGES = [
  {
    name: "/time-entries",
    source: readRouteFile(
      "../routes/(app)/time-entries/+page.svelte",
      "src/routes/(app)/time-entries/+page.svelte",
    ),
  },
  {
    name: "/team/time-entries",
    source: readRouteFile(
      "../routes/(app)/team/time-entries/+page.svelte",
      "src/routes/(app)/team/time-entries/+page.svelte",
    ),
  },
];

describe.each(PAGES)("travel offer wiring (#660) - $name", ({ source }) => {
  it("reads a non-empty page source", () => {
    expect(source.length).toBeGreaterThan(0);
  });

  it("imports the offer helpers from the shared travel module", () => {
    for (const fn of [
      "travelOffersShown",
      "travelOfferPayload",
      "travelOfferErrorText",
      "postOfferIfStillServed",
    ]) {
      expect(source, fn).toMatch(
        new RegExp(
          `import \\{[^}]*\\b${fn}\\b[^}]*\\} from "\\$lib/time-entries/travel-entry-form"`,
        ),
      );
    }
  });

  it("hands the panel the offers only through the #64 gate helper", () => {
    expect(source).toContain("travelOffers={travelOffersShown(dayCheck, multiEntryUi)}");
    expect(source).toContain("onRecordTravel=");
    expect(source).not.toMatch(/dayCheck\.travelOffers/);
    expect(source).not.toMatch(/\.travelOffers\b(?!\s*=\s*\{travelOffersShown)/);
  });

  it("posts the offer only with the one trip body builder and reports a refusal verbatim", () => {
    expect(source).toContain("travelOfferPayload(");
    expect(source).toContain("travelOfferErrorText(");
  });

  it("re-checks the day check right before writing and never posts from a stale panel (WR-01)", () => {
    const start = source.indexOf("async function recordTravelOffer(");
    expect(start).toBeGreaterThan(-1);
    const end = source.indexOf("\n  async function ", start + 10);
    const fn = source.slice(start, end === -1 ? undefined : end);
    // The only write of the offer sits in the `post` callback of the re-checking helper, and the
    // re-check reads the day check of the same single day.
    expect(fn).toContain("postOfferIfStillServed(");
    expect(fn).toMatch(
      /\/day-breaks\/checks\?employeeId=\$\{[A-Za-z]+\}&from=\$\{date\}&to=\$\{date\}/,
    );
    expect(fn.indexOf("postOfferIfStillServed(")).toBeLessThan(fn.indexOf("api.post<"));
    expect(fn.match(/api\.post</g)).toHaveLength(1);
    expect(fn).toContain("toasts.warning(TRAVEL_TEXTS.offerStale)");
    expect(fn).toMatch(/finally \{\s*await loadAll\(\);/);
  });

  it("reads none of the offer's salon fields itself (body and label come from the helpers)", () => {
    for (const field of [
      ".departureSalonId",
      ".arrivalSalonId",
      ".departureSalonName",
      ".arrivalSalonName",
    ]) {
      expect(source, field).not.toContain(field);
    }
  });
});

describe("travel offer wiring (#660) - the team page acts for the person the check belongs to", () => {
  const team = PAGES[1].source;

  /** The source of `recordTravelOffer` up to the next top-level function. */
  function recordFunction(source: string): string {
    const start = source.indexOf("async function recordTravelOffer(");
    expect(start).toBeGreaterThan(-1);
    const end = source.indexOf("\n  async function ", start + 10);
    return source.slice(start, end === -1 ? undefined : end);
  }

  it("sends the checked person's id and source CORRECTION after the offer body (WR-03)", () => {
    expect(team).toMatch(
      /\.\.\.travelOfferPayload\([^)]*\),\s*employeeId: checkedEmployeeId,\s*source: "CORRECTION",?/,
    );
    expect(team).toMatch(/const checkedEmployeeId = dayChecksEmployeeId;/);
  });

  it("never reads the current selection inside the offer action (WR-03)", () => {
    expect(recordFunction(team)).not.toContain("selectedEmployeeId");
  });

  it("carries the person with the loaded checks, clears them when a load starts and drops stale responses (WR-03)", () => {
    expect(team).toContain("dayChecksEmployeeId = rawDayChecks ? rawDayChecks.employeeId : null;");
    expect(team).toContain(
      'import { createLatestRequestGuard } from "$lib/time-entries/latest-request"',
    );
    const load = team.slice(team.indexOf("async function loadAll()"));
    const begin = load.indexOf("loadGuard.begin()");
    const clear = load.indexOf("dayChecks = [];");
    const apply = load.indexOf("dayChecks = rawDayChecks?.days");
    const stale = load.indexOf("if (!loadGuard.isCurrent(loadToken)) return;");
    expect(begin).toBeGreaterThan(-1);
    // Cleared right after the run starts, before any await; the stale check precedes applying.
    expect(clear).toBeGreaterThan(begin);
    expect(clear).toBeLessThan(load.indexOf("await Promise.all"));
    expect(stale).toBeGreaterThan(-1);
    expect(stale).toBeLessThan(apply);
  });
});

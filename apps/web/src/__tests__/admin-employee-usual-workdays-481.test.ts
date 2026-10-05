// Issue #481 (R7) — wiring pins for the übliche-Arbeitstage UI on the two admin employee pages.
//
// Same source-read technique as `admin-employee-save-wiring.test.ts`: neither page is mountable
// in vitest (no `$app` alias). The pure logic lives in `$lib/utils/work-schedule.ts` and is unit
// tested there; these pins prove the pages wire it and that the Nachtrag stays button-gated
// (ADMIN_STRUCTURE §3.2.1).

import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, it, expect } from "vitest";

// fileURLToPath decodes the %28/%29 that the "(app)" route group produces in import.meta.url.
function readRouteFile(relativeFromHere: string, relativeFromCwd: string): string {
  try {
    return readFileSync(fileURLToPath(new URL(relativeFromHere, import.meta.url)), "utf8");
  } catch {
    return readFileSync(resolve(process.cwd(), relativeFromCwd), "utf8");
  }
}

const DETAIL = readRouteFile(
  "../routes/(app)/admin/employees/[id]/+page.svelte",
  "src/routes/(app)/admin/employees/[id]/+page.svelte",
);
const LIST = readRouteFile(
  "../routes/(app)/admin/employees/+page.svelte",
  "src/routes/(app)/admin/employees/+page.svelte",
);

/** Body of `async function <name>(` — fails loudly when the marker is missing. */
function fnBody(source: string, name: string): string {
  const marker = `async function ${name}(`;
  const start = source.indexOf(marker);
  expect(start, `marker not found: ${marker}`).toBeGreaterThan(-1);
  const open = source.indexOf("{", source.indexOf(")", start));
  let depth = 0;
  for (let i = open; i < source.length; i++) {
    if (source[i] === "{") depth++;
    else if (source[i] === "}") {
      depth--;
      if (depth === 0) return source.slice(open, i + 1);
    }
  }
  throw new Error(`unbalanced body for ${name}`);
}

describe("Nachtrag section on admin/employees/[id] (Issue #481 R6/R7)", () => {
  it("loads the contract history", () => {
    expect(DETAIL).toContain("/settings/work/${employeeId}/history");
  });

  it("PATCHes the Nachtrag route only from the named save function", () => {
    const body = fnBody(DETAIL, "saveUsualWorkDaysBackfill");
    expect(body).toContain("api.patch");
    expect(body).toContain("/usual-work-days");
    expect(DETAIL.split("/usual-work-days").length - 1).toBe(1);
  });

  it("the save function is wired to a button, never to a chip", () => {
    expect(DETAIL).toMatch(/<button[\s\S]{0,80}onclick=\{saveUsualWorkDaysBackfill\}/);
    expect(DETAIL).not.toMatch(/wd-chip[\s\S]{0,300}saveUsualWorkDaysBackfill/);
  });

  it("explains itself in German, including that nothing is repriced", () => {
    expect(DETAIL).toContain("Übliche Arbeitstage nachtragen");
    expect(DETAIL).toContain("nicht automatisch neu");
  });
});

describe("übliche Arbeitstage are Pflicht in both contract entry points (Issue #481 R5/R7)", () => {
  for (const [name, source] of [
    ["detail page", DETAIL],
    ["create dialog", LIST],
  ] as const) {
    it(`${name}: no '(optional)', a Pflicht badge, no 'Leer lassen'`, () => {
      expect(source).not.toContain("Übliche Arbeitstage (optional)");
      expect(source).toContain('class="badge badge-gray">Pflicht');
      expect(source).not.toContain("Leer lassen, wenn es keine festen Tage gibt");
    });

    it(`${name}: a callout guarded by usualWorkDaysMissing`, () => {
      expect(source).toMatch(/usualWorkDaysMissing\([\s\S]{0,200}bei Schichtbetrieb Pflicht/);
    });
  }

  it("detail page: the Arbeitszeitmodell save is blocked by the Angabe rule", () => {
    expect(DETAIL).toContain("disabled={arbeitszeitSaving || scheduleBlockedByUsualWorkDays}");
    expect(DETAIL).toMatch(
      /scheduleBlockedByUsualWorkDays = \$derived\([\s\S]{0,200}usualWorkDaysMissing\([\s\S]{0,120}usualWorkDaysShortfall\(/,
    );
  });

  it("create dialog: Anlegen is blocked by the Angabe rule", () => {
    expect(LIST).toContain("disabled={creating || createBlockedByUsualWorkDays}");
    expect(LIST).toMatch(
      /createBlockedByUsualWorkDays = \$derived\([\s\S]{0,200}usualWorkDaysMissing\([\s\S]{0,120}usualWorkDaysShortfall\(/,
    );
  });
});

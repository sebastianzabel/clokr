// Issue #593 (quick part), carried into the Export page of #854 (plan 854-24) - `/admin/export` offers only
// exports that work. The former „Bald“ tiles (PDF-Bericht, iCal) did nothing but toast „Bald verfügbar“; today
// every button on the page starts a real download through `downloadFromApi`. Source-read pin (a route page
// cannot be mounted here, see admin-export-save-wiring.test.ts).
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

const src = readRouteFile(
  "../routes/(app)/admin/export/+page.svelte",
  "src/routes/(app)/admin/export/+page.svelte",
);

describe("Issue #593 — no non-functional placeholders on /admin/export", () => {
  it("has no „Bald“ chip and no „Bald verfügbar“ toast", () => {
    expect(src).not.toMatch(/>Bald</);
    expect(src).not.toContain("Bald verfügbar");
    expect(src).not.toContain("späteren Milestone");
  });

  it("has no decorative CSV preview and no display-only export parameter", () => {
    expect(src).not.toContain("csv-preview");
    expect(src).not.toContain("taxOffice");
    expect(src).not.toContain("Beratungsbüro");
  });

  it("every export button goes through the authorised download helper", () => {
    expect(src).toContain('import { downloadFromApi } from "$api/download";');
    // The paths of the real exports; each is requested only inside `download()`.
    for (const path of [
      "/reports/datev?",
      "/reports/datev/employee?",
      "/reports/monthly-export/pdf?",
      "/leave/ical/",
    ]) {
      expect(src, path).toContain(path);
    }
    expect(src).toContain("periodCsvPath(");
    expect(src).toContain("periodAbsencesCsvPath(");
    expect(src).not.toMatch(/\bfetch\(/);
  });
});

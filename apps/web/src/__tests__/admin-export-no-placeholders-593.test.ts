// Issue #593 (quick part) — `/admin/export` offers only formats that work. The former „Bald“ tiles
// (PDF-Bericht, iCal) did nothing but toast „Bald verfügbar“; the PDF documents live under
// „Berichte“ and the iCal feed under „Abwesenheiten“. Source-read pin (a route page cannot be
// mounted here, see admin-export-save-wiring.test.ts).
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

  it("offers no PDF or iCal tile — only the working DATEV export", () => {
    expect(src).not.toMatch(/format-name">PDF-Bericht/);
    expect(src).not.toMatch(/format-name">iCal/);
    expect(src).toMatch(/format-name" translate="no">DATEV-LODAS/);
  });
});

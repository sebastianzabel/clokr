// Issue #836 (D-06, AC-2, AC-10, AC-11) - the leave-limits UI, pinned from its source. Since #854 (plan 13) it
// is the „Urlaubsgrenzen & Sperren“ tab of Regeln › Abwesenheiten (`UrlaubsgrenzenPanel.svelte`); the old page
// file /admin/leave-limits is gone and both of its URLs are aliases. The behaviour is also mounted in
// components/admin/abwesenheiten/__tests__/urlaubsgrenzen-854.test.ts; this file keeps the source pins of the
// #836 rules the panel must never lose (the web counts nothing, names only what the API returns). The pure
// rules (validation, payload, preset) are tested in lib/leave-limits/__tests__.
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
  "../lib/components/admin/abwesenheiten/UrlaubsgrenzenPanel.svelte",
  "src/lib/components/admin/abwesenheiten/UrlaubsgrenzenPanel.svelte",
);

/** The rule `<Dialog>` element: from its opening tag to the first `</Dialog>`. */
function ruleModal(): string {
  const start = PAGE.indexOf("<Dialog");
  expect(start, "rule Dialog not found").toBeGreaterThan(-1);
  const end = PAGE.indexOf("</Dialog>", start);
  expect(end, "rule Dialog is not closed").toBeGreaterThan(start);
  return PAGE.slice(start, end);
}

describe("Issue #836 - Urlaubsgrenzen & Sperren (tab of Abwesenheiten, #854)", () => {
  it("[vacuity gate] the panel source is read", () => {
    expect(PAGE.length).toBeGreaterThan(5_000);
    expect(ruleModal().length).toBeGreaterThan(500);
  });

  it("the old page file is gone and no route page still carries the UI", () => {
    expect(() =>
      readRouteFile(
        "../routes/(app)/admin/leave-limits/+page.svelte",
        "src/routes/(app)/admin/leave-limits/+page.svelte",
      ),
    ).toThrow();
  });

  it("shows the fixed legal hint inside the rule Dialog (AC-11)", () => {
    expect(PAGE).toContain("LEAVE_LIMIT_LEGAL_HINT");
    expect(ruleModal()).toContain("{LEAVE_LIMIT_LEGAL_HINT}");
  });

  it("has a Urlaubssperre button that opens the blackout preset (AC-10)", () => {
    expect(PAGE).toMatch(/onclick=\{openBlackout\}[^]*?Urlaubssperre/);
    const open = PAGE.indexOf("function openBlackout");
    expect(open).toBeGreaterThan(-1);
    expect(PAGE.slice(open, PAGE.indexOf("\n  }", open))).toContain("blackoutPreset(");
    // The preset asks for a window: validation runs with the blackout flag.
    expect(PAGE).toContain("validateRuleForm(form, { blackout: blackoutMode })");
  });

  it("sends the body through ruleFormPayload and saves only by the Speichern button (AC-2)", () => {
    expect(PAGE).toContain("ruleFormPayload(form)");
    // The Dialog's form submits through the footer button; there is no save on blur or change.
    expect(ruleModal()).toContain("void saveRule()");
    expect(ruleModal()).toContain('type="submit" form="leave-limit-form"');
    expect(ruleModal()).toContain("Speichern");
    expect(PAGE).not.toContain("onblur=");
    expect(PAGE).not.toMatch(/onchange=\{[^}]*(api\.|[Ss]ave[A-Z])/);
  });

  it("offers 'Alle Salons' in the form only to a caller who may manage every salon", () => {
    expect(PAGE).toContain("ruleSalonChoices(reachableSalons, canManageAllSalons,");
    expect(PAGE).toContain("canManageAllSalons = res.canManageAllSalons");
  });

  it("removes a rule through a confirmation and the soft-removal call", () => {
    expect(PAGE).toContain("<ConfirmDialog");
    expect(PAGE).toContain("Regel entfernen?");
    expect(PAGE).toContain("removeLeaveLimitRule(");
  });

  it("shows change controls only where the API says canManage", () => {
    expect(PAGE).toMatch(/\{#if row\.canManage\}[^]*?openEdit\(row\)[^]*?askRemove\(row\)/);
  });

  it("counts nothing and names no person itself: it renders what the API returns (T-854-32)", () => {
    // No parallel-leave count of its own (#836: the kernel is the API's) and no person fields in the panel.
    expect(PAGE).not.toMatch(/parallelLeaveLoad|hiddenCount|firstName|lastName|employeeId/);
    expect(PAGE).not.toMatch(/\.reduce\(|\.filter\(/);
  });

  it("reads and writes only through the leave-limits API module, never a raw path", () => {
    expect(PAGE).not.toContain("api.get(");
    expect(PAGE).not.toContain("api.post(");
    expect(PAGE).not.toContain("api.put(");
    expect(PAGE).not.toContain("api.delete(");
  });

  it("the tab is registered as a section and a tab of the Abwesenheiten page under that name", () => {
    expect(PAGE).toContain("Urlaubsgrenzen & Sperren");
    expect(
      readRouteFile("../lib/settings/abwesenheiten.ts", "src/lib/settings/abwesenheiten.ts"),
    ).toMatch(/value: "urlaubsgrenzen",\s+label: "Urlaubsgrenzen & Sperren"/);
    expect(
      readRouteFile("../lib/settings/settings-pages.ts", "src/lib/settings/settings-pages.ts"),
    ).toMatch(/id: "abwesenheiten-urlaubsgrenzen"[^}]*source: "\/admin\/leave-limits"/);
  });
});

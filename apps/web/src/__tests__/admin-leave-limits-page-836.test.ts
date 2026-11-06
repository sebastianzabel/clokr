// Issue #836 (D-06, AC-2, AC-10, AC-11) - the /admin/leave-limits page, pinned from its source: a
// route page cannot be mounted (no `$app` alias), see admin-shifts-coverage-salon-647.test.ts for
// the precedent. The pure rules (validation, payload, preset) are tested in
// lib/leave-limits/__tests__.
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
  "../routes/(app)/admin/leave-limits/+page.svelte",
  "src/routes/(app)/admin/leave-limits/+page.svelte",
);

/** The rule `<Modal>` element: from its opening tag to the first `</Modal>`. */
function ruleModal(): string {
  const start = PAGE.indexOf("<Modal");
  expect(start, "rule Modal not found").toBeGreaterThan(-1);
  const end = PAGE.indexOf("</Modal>", start);
  expect(end, "rule Modal is not closed").toBeGreaterThan(start);
  return PAGE.slice(start, end);
}

describe("Issue #836 - /admin/leave-limits", () => {
  it("[vacuity gate] the page source is read", () => {
    expect(PAGE.length).toBeGreaterThan(5_000);
    expect(ruleModal().length).toBeGreaterThan(500);
  });

  it("shows the fixed legal hint inside the rule Modal (AC-11)", () => {
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
    expect(ruleModal()).toContain("onclick={saveRule}");
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
    expect(PAGE).toMatch(/\{#if rule\.canManage\}[^]*?openEdit\(rule\)[^]*?askRemove\(rule\)/);
  });

  it("reads and writes only through the leave-limits API module, never a raw path", () => {
    expect(PAGE).not.toContain("api.get(");
    expect(PAGE).not.toContain("api.post(");
    expect(PAGE).not.toContain("api.put(");
    expect(PAGE).not.toContain("api.delete(");
  });

  it("the nav label equals the page title and the title map entry", () => {
    expect(PAGE).toContain('title="Urlaubsgrenzen & Sperren"');
    expect(
      readRouteFile("../routes/(app)/+layout.svelte", "src/routes/(app)/+layout.svelte"),
    ).toContain('"/admin/leave-limits": "Urlaubsgrenzen & Sperren"');
  });
});

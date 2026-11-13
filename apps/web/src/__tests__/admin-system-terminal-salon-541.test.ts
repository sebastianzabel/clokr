// Issue #541 (D-03, D-08, D-11) - source-read pin of the terminal salon wiring. Since plan 854-14 the terminals
// live in the panel of System > Integrationen (`TerminalsPanel.svelte`), not on System > Allgemein. The panel is
// mounted by `terminals-panel-854.test.ts`; this file keeps the original source pins (the same assertions as before
// the move): the cell is proven by its mount test and the save logic (optimistic update, revert before the toast)
// by the unit test of `$lib/admin/terminal-salon-save`.
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

const SRC = join(__dirname, "..");
const PANEL = readFileSync(
  join(SRC, "lib/components/admin/integrationen/TerminalsPanel.svelte"),
  "utf8",
);
const SYSTEM = readFileSync(join(SRC, "routes/(app)/admin/system/+page.svelte"), "utf8");

/** Brace-depth slice of a function body starting at its marker. */
function fnBody(marker: string): string {
  const start = PANEL.indexOf(marker);
  expect(start, `marker not found: ${marker}`).toBeGreaterThan(-1);
  const open = PANEL.indexOf("{", PANEL.indexOf(")", start));
  let depth = 0;
  for (let i = open; i < PANEL.length; i++) {
    if (PANEL[i] === "{") depth++;
    else if (PANEL[i] === "}" && --depth === 0) return PANEL.slice(open, i + 1);
  }
  throw new Error(`unterminated body: ${marker}`);
}

describe("Issue #541 - terminal salon wiring on System > Integrationen", () => {
  it("the panel file exists and System > Allgemein no longer carries terminals", () => {
    expect(existsSync(join(SRC, "lib/components/admin/integrationen/TerminalsPanel.svelte"))).toBe(
      true,
    );
    expect(SYSTEM).not.toContain("TerminalSalonCell");
    expect(SYSTEM).not.toContain("/terminals");
  });

  it("renders the cell in the terminal table and saves through setTerminalSalon", () => {
    expect(PANEL).toContain("<TerminalSalonCell");
    expect(PANEL).toContain("onchange={(salonId) => setTerminalSalon(row.id, salonId)}");
  });

  it("setTerminalSalon delegates to saveTerminalSalon (behaviour: terminal-salon-save.test.ts)", () => {
    expect(PANEL).toContain('from "$lib/admin/terminal-salon-save"');
    const body = fnBody("function setTerminalSalon(");
    expect(body).toContain("saveTerminalSalon<TerminalKey>(");
    expect(body).toContain("`/terminals/${keyId}`");
  });

  it("the salon column follows showSalonOptions and shows whenever a key is bound", () => {
    const m = PANEL.match(/const showSalonColumn = \$derived\(([\s\S]*?)\);\n/);
    expect(m, "showSalonColumn not found").not.toBeNull();
    expect(m![1]).toContain("salonOptionsShown");
    expect(m![1]).toMatch(/salonId !== null/);
    expect(PANEL).toMatch(/const salonOptionsShown = \$derived\(showSalonOptions\(/);
  });

  it("the create dialog select is guarded by salonOptionsShown and the id is sent only when chosen", () => {
    const form = PANEL.indexOf('id="terminal-create-form"');
    expect(form).toBeGreaterThan(-1);
    const select = PANEL.indexOf("bind:value={newSalonId}", form);
    expect(select).toBeGreaterThan(form);
    const guard = PANEL.lastIndexOf("{#if salonOptionsShown}", select);
    expect(guard).toBeGreaterThan(form);
    expect(fnBody("async function createTerminalKey(")).toContain(
      '...(newSalonId !== "" && { salonId: newSalonId })',
    );
  });

  it("keeps exactly one HARDWARE_CLOCK hint", () => {
    expect(PANEL.match(/<ModuleHint module="HARDWARE_CLOCK"/g)).toHaveLength(1);
  });
});

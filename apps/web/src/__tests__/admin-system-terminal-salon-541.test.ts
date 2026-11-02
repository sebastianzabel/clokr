// Issue #541 (D-03, D-08, D-11) — source-read pin of the terminal salon wiring on
// `admin/system/+page.svelte`. A route page cannot be mounted (`apps/web/vitest.config.ts` has no
// `$app` alias; see admin-system-save-wiring.test.ts for the precedent), so the wiring is pinned by
// reading the source; the cell is proven by its mount test and the save logic (optimistic update,
// revert before the toast) by the unit test of `$lib/admin/terminal-salon-save`.
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

function readRouteFile(relativeFromHere: string, relativeFromCwd: string): string {
  try {
    return readFileSync(fileURLToPath(new URL(relativeFromHere, import.meta.url)), "utf8");
  } catch {
    return readFileSync(resolve(process.cwd(), relativeFromCwd), "utf8");
  }
}

const PAGE = readRouteFile(
  "../routes/(app)/admin/system/+page.svelte",
  "src/routes/(app)/admin/system/+page.svelte",
);

/** The NFC-Terminals section: from its title to the next section title. */
function terminalSection(): string {
  const start = PAGE.indexOf('<Section title="NFC-Terminals"');
  expect(start, "NFC-Terminals section not found").toBeGreaterThan(-1);
  const end = PAGE.indexOf("<Section ", start + 10);
  expect(end).toBeGreaterThan(start);
  return PAGE.slice(start, end);
}

/** Brace-depth slice of a function body starting at its marker. */
function fnBody(marker: string): string {
  const start = PAGE.indexOf(marker);
  expect(start, `marker not found: ${marker}`).toBeGreaterThan(-1);
  const open = PAGE.indexOf("{", PAGE.indexOf(")", start));
  let depth = 0;
  for (let i = open; i < PAGE.length; i++) {
    if (PAGE[i] === "{") depth++;
    else if (PAGE[i] === "}" && --depth === 0) return PAGE.slice(open, i + 1);
  }
  throw new Error(`unterminated body: ${marker}`);
}

describe("Issue #541 — terminal salon wiring on /admin/system", () => {
  it("renders the cell in the terminal table and saves through setTerminalSalon", () => {
    const section = terminalSection();
    expect(section).toContain("<TerminalSalonCell");
    expect(section).toContain("onchange={(salonId) => setTerminalSalon(key.id, salonId)}");
  });

  it("setTerminalSalon delegates to saveTerminalSalon (behaviour: terminal-salon-save.test.ts)", () => {
    expect(PAGE).toContain('from "$lib/admin/terminal-salon-save"');
    const body = fnBody("function setTerminalSalon(");
    expect(body).toContain("saveTerminalSalon<TerminalKey>(");
    expect(body).toContain("`/terminals/${keyId}`");
  });

  it("the salon column follows showSalonOptions and shows whenever a key is bound", () => {
    const m = PAGE.match(/const showTerminalSalonColumn = \$derived\(([\s\S]*?)\);\n/);
    expect(m, "showTerminalSalonColumn not found").not.toBeNull();
    expect(m![1]).toContain("salonOptionsShown");
    expect(m![1]).toMatch(/salonId !== null/);
    expect(PAGE).toMatch(/const salonOptionsShown = \$derived\(showSalonOptions\(/);
  });

  it("the create-row select sits inside inline-create, guarded by salonOptionsShown", () => {
    const section = terminalSection();
    const create = section.indexOf('class="inline-create"');
    expect(create).toBeGreaterThan(-1);
    const select = section.indexOf('aria-label="Salon des neuen Terminals"');
    expect(select).toBeGreaterThan(create);
    const guard = section.lastIndexOf("{#if salonOptionsShown}", select);
    expect(guard).toBeGreaterThan(create);
    // the id is sent only when one is chosen (D-03)
    expect(fnBody("async function createTerminalKey(")).toContain(
      '...(newKeySalonId !== "" && { salonId: newKeySalonId })',
    );
  });

  it("keeps exactly one HARDWARE_CLOCK hint", () => {
    expect(PAGE.match(/<ModuleHint module="HARDWARE_CLOCK"/g)).toHaveLength(1);
  });
});

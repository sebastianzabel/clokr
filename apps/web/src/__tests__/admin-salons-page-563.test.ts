// Issue #563 - source pins for the tenant salon admin pages and the reduced admin/system section.
//
// Routes cannot be mounted (`apps/web/vitest.config.ts` has no `$app` alias, see
// `admin-system-save-wiring.test.ts` and `layout-boundaries.test.ts`), so the page contract is read
// from source: the exact PATCH body, the context reload after a successful write, the unsaved
// registration, the rights call, the operator isolation and the shape of admin/system.

import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, it, expect } from "vitest";

function readRouteFile(relativeFromHere: string, relativeFromCwd: string): string {
  const fromHere = fileURLToPath(new URL(relativeFromHere, import.meta.url));
  const path = existsSync(fromHere) ? fromHere : resolve(process.cwd(), relativeFromCwd);
  // A missing page must fail the pin with a clear message instead of throwing before `expect`.
  expect(existsSync(path), `page source missing: ${relativeFromCwd}`).toBe(true);
  return readFileSync(path, "utf8");
}

const DETAIL = readRouteFile(
  "../routes/(app)/admin/salons/[id]/+page.svelte",
  "src/routes/(app)/admin/salons/[id]/+page.svelte",
);
const LIST = readRouteFile(
  "../routes/(app)/admin/salons/+page.svelte",
  "src/routes/(app)/admin/salons/+page.svelte",
);
const SYSTEM = readRouteFile(
  "../routes/(app)/admin/system/+page.svelte",
  "src/routes/(app)/admin/system/+page.svelte",
);

/** The text of `signature { ... }` up to its matching closing brace. */
function fnBody(source: string, signature: string): string {
  const start = source.indexOf(signature);
  expect(start, `${signature} not found`).toBeGreaterThanOrEqual(0);
  const open = source.indexOf("{", source.indexOf(")", start));
  let depth = 0;
  for (let i = open; i < source.length; i++) {
    if (source[i] === "{") depth++;
    if (source[i] === "}") {
      depth--;
      if (depth === 0) return source.slice(open, i + 1);
    }
  }
  throw new Error(`unbalanced braces after ${signature}`);
}

function importSpecifiers(source: string): string[] {
  return [...source.matchAll(/from\s+["']([^"']+)["']/g)].map((m) => m[1]);
}

describe("salon detail page - the write", () => {
  const SAVE = () => fnBody(DETAIL, "async function saveHours");

  it("PATCHes /salons/:id with an object whose only key is openingHours", () => {
    const m = /api\.patch\(\s*`\/salons\/\$\{[^`]*\}`\s*,\s*\{([^}]*)\}\s*\)/.exec(DETAIL);
    expect(m, "api.patch(`/salons/${...}`, { ... }) not found").not.toBeNull();
    const keys = (m?.[1] ?? "")
      .split(",")
      .map((part) => part.split(":")[0].trim())
      .filter(Boolean);
    expect(keys).toEqual(["openingHours"]);
  });

  it("reloads the salon context with force: true after the PATCH succeeded", () => {
    const body = SAVE();
    const patchAt = body.indexOf("api.patch(");
    const reloadAt = body.indexOf("await refreshSalonContext()");
    expect(patchAt).toBeGreaterThanOrEqual(0);
    expect(reloadAt).toBeGreaterThan(patchAt);
    const helper = fnBody(DETAIL, "async function refreshSalonContext");
    expect(helper).toMatch(/salonContext\.load\([^)]*\{\s*force:\s*true\s*\}\s*\)/);
  });

  it("validates before it sends", () => {
    const body = SAVE();
    expect(body.indexOf("validateOpeningHours(")).toBeGreaterThanOrEqual(0);
    expect(body.indexOf("validateOpeningHours(")).toBeLessThan(body.indexOf("api.patch("));
  });

  it("registers unsaved state gated on the baseline and de-registers on unmount", () => {
    expect(DETAIL).toContain('markUnsaved("admin-salon-detail", snapshotsReady && ');
    expect(DETAIL).toContain('markUnsaved("admin-salon-detail", false)');
  });

  it("decides what it shows by salonAdminRights() and uses the shared editor", () => {
    expect(DETAIL).toContain("salonAdminRights(");
    expect(importSpecifiers(DETAIL)).toContain("$lib/components/admin/OpeningHoursEditor.svelte");
  });
});

describe("salon pages - isolation and escaping", () => {
  it("no import specifier of either page names the operator console", () => {
    for (const source of [DETAIL, LIST]) {
      for (const specifier of importSpecifiers(source)) {
        expect(specifier.toLowerCase()).not.toContain("operator");
      }
    }
  });

  it("neither page renders raw HTML", () => {
    expect(DETAIL).not.toContain("{@html");
    expect(LIST).not.toContain("{@html");
  });
});

describe("salon list page", () => {
  it("fetches every salon, titles itself 'Salons' and holds no unsaved state", () => {
    expect(LIST).toContain("/salons?includeInactive=true");
    expect(LIST).toContain('title="Salons"');
    expect(LIST).not.toContain("markUnsaved(");
  });
});

describe("admin/system keeps only the shift check mode (D-12)", () => {
  it("no longer holds the opening-hours editor or any tenant-level hours", () => {
    expect(SYSTEM).not.toContain("OpeningHoursEditor");
    expect(SYSTEM).not.toMatch(/\bstoreHours\b/);
  });

  it("still renders the three shiftStoreHoursMode radios", () => {
    expect((SYSTEM.match(/name="shiftStoreHoursMode"/g) ?? []).length).toBe(3);
  });

  it("saves the mode with the minimal payload, never the full other-fields spread", () => {
    const body = fnBody(SYSTEM, "async function saveShiftHoursMode");
    expect(body).toContain('api.put("/settings/work"');
    expect(body).toContain("shiftStoreHoursMode");
    expect(body).not.toContain("_gOtherFields");
  });
});

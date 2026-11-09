// Issue #610 (D-11, P-610-20) - source pins for the pairing route.
//
// Routes cannot be mounted (`apps/web/vitest.config.ts` has no `$app` alias, see
// `admin-salons-page-563.test.ts`), so the contract that depends on the router is read from source:
// the code is read once from the page URL, the component gets it, and the address bar is cleaned with
// SvelteKit's `replaceState` (not the browser History API) once the component reports the preview
// settled. The mounted behaviour is `DevicePairing.test.ts`.
import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

function readSource(relativeFromHere: string, relativeFromCwd: string): string {
  const fromHere = fileURLToPath(new URL(relativeFromHere, import.meta.url));
  const path = existsSync(fromHere) ? fromHere : resolve(process.cwd(), relativeFromCwd);
  expect(existsSync(path), `source missing: ${relativeFromCwd}`).toBe(true);
  return readFileSync(path, "utf8");
}

const ROUTE = readSource(
  "../routes/(app)/settings/geraet-koppeln/+page.svelte",
  "src/routes/(app)/settings/geraet-koppeln/+page.svelte",
);
// Issue #574: the top bar's page label comes from the one page-name table
const LAYOUT = readSource("../lib/nav/page-labels.ts", "src/lib/nav/page-labels.ts");
const COMPONENT = readSource(
  "../lib/components/settings/DevicePairing.svelte",
  "src/lib/components/settings/DevicePairing.svelte",
);

describe("pairing route (source pins)", () => {
  it("reads the code from the page URL search params once, not reactively", () => {
    expect(ROUTE).toContain('searchParams.get("code")');
    expect(ROUTE).toContain("get(page)");
    expect(ROUTE).not.toContain("$page");
    expect((ROUTE.match(/searchParams\.get\(/g) ?? []).length).toBe(1);
  });

  it("renders the component with the code and an onCodeHandled", () => {
    expect(ROUTE).toMatch(/<DevicePairing\s+\{code\}\s+\{onCodeHandled\}/);
  });

  it("cleans the address bar with replaceState from $app/navigation on the pairing path", () => {
    expect(ROUTE).toMatch(/import \{ replaceState \} from "\$app\/navigation"/);
    expect(ROUTE).toContain('replaceState("/settings/geraet-koppeln", {})');
  });

  it("calls replaceState only through stripCodeFromAddress (WR-06), never directly from onMount", () => {
    expect(ROUTE).toContain('from "$lib/presence/strip-code"');
    expect((ROUTE.match(/replaceState\(/g) ?? []).length).toBe(1);
    expect(ROUTE).toMatch(/stripCodeFromAddress\(\{[^}]*strip: \(\) => replaceState\(/s);
  });

  it("does not use the browser History API directly", () => {
    expect(ROUTE).not.toMatch(/history\./);
    expect(ROUTE).not.toContain("window.history");
  });

  it("the page label of the top bar names the page", () => {
    expect(LAYOUT).toContain('"/settings/geraet-koppeln": "Handy koppeln"');
  });
});

describe("pairing component (source pins)", () => {
  it("renders nothing as markup and never touches the router", () => {
    expect(COMPONENT).not.toContain("@html");
    expect(COMPONENT).not.toContain("$app/");
  });

  it("sends consent only through confirmPairing, called from the one handler", () => {
    expect((COMPONENT.match(/confirmPairing\(/g) ?? []).length).toBe(1);
    // The flag is built in the API client only; the component never spells it.
    expect(COMPONENT).not.toMatch(/consent\s*:\s*true/);
  });
});

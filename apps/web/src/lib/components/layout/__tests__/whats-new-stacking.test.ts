// Phase 110-07 checkpoint fix — the drawer's own close button was unreachable.
//
// Measured in the running app at 1512x806: `.whats-new-close` sat at z-index 150 while the
// Topbar sat at 1000, so `document.elementFromPoint()` on the close button's centre returned the
// Topbar avatar, and a real click never reached the button.
//
// This test environment does not inject component-scoped <style> tags into jsdom's
// `document.head` (confirmed empirically, same finding documented in
// `apps/web/src/lib/components/saldo/__tests__/KontoSaldoCard.test.ts`), so `getComputedStyle()`
// on a mounted `.whats-new` element cannot see its own scoped z-index. The only thing this suite
// can actually verify against a silent regression is the source text of the components that
// participate in the stacking order -- so it reads the real z-index declarations back out of
// each component's own <style> block, the same way `KontoSaldoCard.test.ts` pins its dark-mode
// fallback by source rather than by computed style.
import { describe, expect, it } from "vitest";
import { readFileSync } from "fs";
import { join } from "path";

function zIndexOf(relativePath: string, selector: string): number {
  const source = readFileSync(join(__dirname, "..", "..", "..", "..", relativePath), "utf-8");
  const styleBlock = source.match(/<style>([\s\S]*)<\/style>/)?.[1] ?? "";
  const selectorRe = new RegExp(
    `${selector.replace(/[.#]/g, "\\$&")}\\s*{[^}]*z-index:\\s*(-?\\d+)`,
  );
  const match = styleBlock.match(selectorRe);
  if (!match) {
    throw new Error(`No z-index found for ${selector} in ${relativePath}`);
  }
  return Number(match[1]);
}

describe("WhatsNewPanel — stacking order (Plan 07 checkpoint fix)", () => {
  const whatsNewZ = zIndexOf("lib/components/layout/WhatsNewPanel.svelte", ".whats-new");
  const topbarZ = zIndexOf("lib/components/layout/Topbar.svelte", ".topbar");
  const commandPaletteBackdropZ = zIndexOf(
    "lib/components/ui/CommandPalette.svelte",
    ".cmd-backdrop",
  );
  const toastZ = zIndexOf("lib/components/ui/Toast.svelte", ".toast-container");

  it("sits above the Topbar so its own close button is not covered by app chrome", () => {
    // Regression guard for the exact defect: before the fix whatsNewZ (150) < topbarZ (1000),
    // which is what made elementFromPoint() on the close button resolve to the Topbar avatar.
    expect(whatsNewZ).toBeGreaterThan(topbarZ);
  });

  it("stays below the global CommandPalette overlay", () => {
    expect(whatsNewZ).toBeLessThan(commandPaletteBackdropZ);
  });

  it("stays below Toast, so an error toast remains visible while the drawer is open", () => {
    expect(whatsNewZ).toBeLessThan(toastZ);
  });
});

// Phase 566 (D-12) — the calm module hint, mounted: the exact German sentence, no alert, no
// dialog, nothing clickable. `lint:ui-classes` does not scan this directory, so the mount test is
// the component's gate.
import { describe, expect, it } from "vitest";
import { screen } from "@testing-library/svelte";

import { renderWithTheme } from "$tests/test-utils";
import { TENANT_MODULES, TENANT_MODULE_LABELS } from "$lib/packages/tenant-modules";
import ModuleHint from "../ModuleHint.svelte";

describe("ModuleHint", () => {
  it.each([...TENANT_MODULES])("says which module unlocks the subject (%s)", (module) => {
    renderWithTheme(ModuleHint, { module, subject: "NFC-Terminals" });
    const hint = screen.getByTestId("module-hint");
    expect(hint.textContent?.replace(/\s+/g, " ").trim()).toBe(
      `NFC-Terminals sind mit dem Zusatzmodul ${TENANT_MODULE_LABELS[module]} verfügbar. Ihr Anbieter schaltet es frei.`,
    );
    expect(hint.getAttribute("data-module")).toBe(module);
  });

  it("is a calm note: no alert, no dialog, no button, no link", () => {
    const { container } = renderWithTheme(ModuleHint, {
      module: "HARDWARE_CLOCK",
      subject: "NFC-Terminals",
    });
    expect(container.querySelector('[role="alert"]')).toBeNull();
    expect(container.querySelector('[role="dialog"], [role="alertdialog"], dialog')).toBeNull();
    expect(container.querySelector("button, a, [role='button'], input")).toBeNull();
    expect(screen.getByTestId("module-hint").getAttribute("role")).toBe("note");
  });
});

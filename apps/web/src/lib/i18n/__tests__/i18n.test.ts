// i18n.test.ts — locks DE/EN bundle parity, t() helper contract, and globalThis pinning.
// Plan 33-01 (I18N-01, I18N-02): proves DE strings match handoff verbatim, EN bundle is
// reachable at runtime (grep-verifiable in built asset), and DE/EN key sets are identical.
//
// IMPORTANT: Imports from '../index' (not '../de' / '../en' directly) so the side-effect
// globalThis pinning runs and the EN bundle gets registered.
import { describe, it, expect } from "vitest";
import { de, en, t } from "../index";

describe("i18n module", () => {
  it("t('save') returns 'Speichern' (DE is the active locale)", () => {
    expect(t("save")).toBe("Speichern");
  });

  it("t('monthly_close') returns 'Monatsabschluss' (compliance vocabulary preserved)", () => {
    expect(t("monthly_close")).toBe("Monatsabschluss");
  });

  it("t('arbzg_break') returns the exact handoff DE string (regression guard for I18N-01)", () => {
    expect(t("arbzg_break")).toBe(
      "Pflichtpause § 4 ArbZG: bei > 6 Std. mindestens 30 Min. Pause erforderlich.",
    );
  });

  it("Object.keys(de) and Object.keys(en) produce identical sorted arrays (DE/EN parity)", () => {
    const deKeys = Object.keys(de).sort();
    const enKeys = Object.keys(en).sort();
    expect(JSON.stringify(deKeys)).toBe(JSON.stringify(enKeys));
  });

  it("globalThis.__CLOKR_I18N__.en.save === 'Save' (EN bundle reachable at runtime)", () => {
    // The presence of this pinning ensures the EN bundle survives tree-shaking
    // (required for I18N-02 build verification).
    expect((globalThis as unknown as { __CLOKR_I18N__?: { en: typeof en } }).__CLOKR_I18N__?.en?.save).toBe(
      "Save",
    );
  });

  it("for every key in de, typeof de[k] === typeof en[k] and arrays have identical length", () => {
    // Catches drift in months[12] / dow[7] and string-vs-array type mismatches.
    for (const key of Object.keys(de) as Array<keyof typeof de>) {
      const deVal = de[key];
      const enVal = en[key as keyof typeof en];
      expect(typeof deVal, `type mismatch for key '${key}'`).toBe(typeof enVal);
      if (Array.isArray(deVal)) {
        expect(Array.isArray(enVal), `en.${key} should be an array`).toBe(true);
        expect((deVal as readonly string[]).length, `array length mismatch for key '${key}'`).toBe(
          (enVal as readonly string[]).length,
        );
      }
    }
  });
});

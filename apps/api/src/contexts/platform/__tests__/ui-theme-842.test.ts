/**
 * Issue #842 (D-842-17/D-842-18) — DB-free unit test of the shared theme mapping.
 */
import { describe, it, expect } from "vitest";
import { LEGACY_UI_THEME_IDS, UI_THEME_IDS, normalizeUiTheme } from "../ui-theme";

describe("normalizeUiTheme (#842)", () => {
  it("lists exactly the three current and the three retired ids", () => {
    expect([...UI_THEME_IDS]).toEqual(["pflaume", "salz", "petrol"]);
    expect([...LEGACY_UI_THEME_IDS]).toEqual(["nacht", "schiefer", "wald"]);
  });

  it.each([
    ["pflaume", "pflaume"],
    ["salz", "salz"],
    ["petrol", "petrol"],
    ["nacht", "salz"],
    ["schiefer", "salz"],
    ["wald", "petrol"],
  ])("maps %s to %s", (input, expected) => {
    expect(normalizeUiTheme(input)).toBe(expected);
  });

  it.each([["lila"], [""], [null], [undefined], [42], [{}], ["constructor"], ["__proto__"]])(
    "falls back to pflaume for %j",
    (input) => {
      expect(normalizeUiTheme(input)).toBe("pflaume");
    },
  );
});

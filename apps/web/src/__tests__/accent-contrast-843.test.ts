// #843 — the honey accent is a meaningful non-text element ("now", "break"): WCAG 1.4.11 asks for
// at least 3:1 against the surfaces it sits on. Resolved from the real tokens.css in all six
// theme x mode combinations through the one cascade resolver.

import { describe, expect, it } from "vitest";

import {
  COMBINATION_NAMES,
  contrast,
  over,
  readTokensCss,
  resolveColor,
  type CombinationName,
} from "./token-css";

const CSS = readTokensCss();

describe("accent-contrast-843 — the accent reaches 3:1 on card and bg (WCAG 1.4.11)", () => {
  it("covers all six combinations", () => {
    expect(COMBINATION_NAMES).toHaveLength(6);
  });

  for (const combination of COMBINATION_NAMES as CombinationName[]) {
    it(`${combination}: accent on bg and on card >= 3:1`, () => {
      const bg = resolveColor(CSS, combination, "var(--bg)");
      const card = over(resolveColor(CSS, combination, "var(--card)"), bg);
      const accent = resolveColor(CSS, combination, "var(--accent)");
      expect(contrast(over(accent, bg), bg), `${combination} on bg`).toBeGreaterThanOrEqual(3);
      expect(contrast(over(accent, card), card), `${combination} on card`).toBeGreaterThanOrEqual(
        3,
      );
    });
  }

  it("the check can fail: the prototype honey #d9a441 stays below 3:1 on white", () => {
    const white = resolveColor(CSS, "pflaume-light", "#ffffff");
    const honey = resolveColor(CSS, "pflaume-light", "#d9a441");
    expect(contrast(honey, white)).toBeLessThan(3);
  });
});

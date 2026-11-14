// Issue #950 — an understaffed day is "zu wenig besetzt", never "Konflikt"; "Konflikt" stays the
// shift inside approved leave, and the two never share a colour in the roster.
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { ROSTER_LEGEND_PROBLEMS, staffingStatusText } from "$lib/shifts/staffing";

const page = readFileSync("src/routes/(app)/shifts/+page.svelte", "utf8");

function rule(selector: string): string {
  const m = page.match(new RegExp(`${selector.replace(/[.]/g, "\\.")}\\s*\\{([^}]*)\\}`));
  expect(m, selector).not.toBeNull();
  return m![1];
}

describe("roster legend names a shortfall and a conflict apart (Issue #950)", () => {
  it("words the shortfall from the staffing module, not as Konflikt", () => {
    expect(ROSTER_LEGEND_PROBLEMS.under).toBe(`${staffingStatusText("under")} besetzt`);
    expect(ROSTER_LEGEND_PROBLEMS.under).not.toMatch(/konflikt/i);
    expect(ROSTER_LEGEND_PROBLEMS.conflict).toBe("Konflikt");
  });

  it("lists both entries in the legend, with the page using the shared wording", () => {
    expect(page).toContain("sp-key--under");
    expect(page).toContain("{ROSTER_LEGEND_PROBLEMS.under}");
    expect(page).toContain("{ROSTER_LEGEND_PROBLEMS.conflict}");
    expect(page).not.toMatch(/sp-key--conflict"><\/span>Konflikt</);
  });

  it("draws the shortfall bar and the conflict key in different colours", () => {
    const under = rule(".sp-staff--under .sp-staff-fill");
    const conflictKey = rule(".sp-key--conflict");
    const colour = (css: string) => css.match(/background:\s*(var\(--[a-z-]+\))/)![1];
    expect(colour(under)).toBe("var(--bad)");
    expect(colour(under)).not.toBe(colour(conflictKey));
    expect(colour(rule(".sp-key--under"))).toBe(colour(under));
  });
});

// Issue #840 G-3 — LeaveTypeChip: the one type chip of list rows. The colour pair comes from the
// mapping (`leaveTypeColor`), a pending request is dashed, extra attributes land on the root.
import { describe, it, expect } from "vitest";
import { screen } from "@testing-library/svelte";
import { renderWithTheme } from "$tests/test-utils";
import { leaveTypeColor } from "$lib/leave/leave-colors";
import {
  SURFACES,
  cardSurface,
  contrast,
  over,
  readTokensCss,
  resolveColor,
  type SurfaceName,
} from "../../../../__tests__/token-css";
import LeaveTypeChip from "../LeaveTypeChip.svelte";

function render(props: Record<string, unknown>) {
  renderWithTheme(LeaveTypeChip, props);
  return screen.getByTestId("chip");
}

describe("colour binding", () => {
  it("binds the fill and its -text partner of the type from the mapping", () => {
    const chip = render({ code: "VACATION", label: "Urlaub", "data-testid": "chip" });
    expect(chip.style.getPropertyValue("--chip-fill")).toBe(
      `var(${leaveTypeColor("VACATION").fill})`,
    );
    expect(chip.style.getPropertyValue("--chip-text")).toBe(
      `var(${leaveTypeColor("VACATION").text})`,
    );
    expect(chip.style.getPropertyValue("--chip-fill")).toBe("var(--leave-type-vacation)");
    expect(chip.style.getPropertyValue("--chip-text")).toBe("var(--leave-type-vacation-text)");
  });

  it("draws sick leave in the sick pair", () => {
    const chip = render({ code: "SICK", label: "Krankmeldung", "data-testid": "chip" });
    expect(chip.style.getPropertyValue("--chip-fill")).toBe("var(--leave-type-sick)");
    expect(chip.style.getPropertyValue("--chip-text")).toBe("var(--leave-type-sick-text)");
  });

  it("draws no type in the neutral absent pair", () => {
    const chip = render({ code: null, label: "Abwesend", "data-testid": "chip" });
    expect(chip.style.getPropertyValue("--chip-fill")).toBe(`var(${leaveTypeColor(null).fill})`);
    expect(chip.style.getPropertyValue("--chip-fill")).toBe("var(--leave-type-absent)");
  });

  it("draws an unknown code in the fallback pair, never the brand colour", () => {
    const chip = render({ code: "NOT_A_CODE", label: "Andere", "data-testid": "chip" });
    expect(chip.style.getPropertyValue("--chip-fill")).toBe("var(--leave-type-default)");
    expect(chip.className).not.toContain("chip-brand");
  });
});

describe("markup", () => {
  it("renders the label on the global chip recipe", () => {
    const chip = render({ code: "VACATION", label: "Urlaub", "data-testid": "chip" });
    expect(chip.textContent?.trim()).toBe("Urlaub");
    expect(chip.classList.contains("chip")).toBe(true);
    expect(chip.classList.contains("chip-brand")).toBe(false);
  });

  it("is solid by default and dashed when requested", () => {
    const solid = render({ code: "VACATION", label: "Urlaub", "data-testid": "chip" });
    expect(solid.className).not.toMatch(/leave-type-chip--requested/);
    document.body.innerHTML = "";
    const dashed = render({
      code: "VACATION",
      label: "Urlaub",
      requested: true,
      "data-testid": "chip",
    });
    expect(dashed.className).toMatch(/leave-type-chip--requested/);
  });

  it("passes data attributes through to the root", () => {
    const chip = render({
      code: "VACATION",
      label: "Urlaub",
      "data-testid": "chip",
      "data-row-status": "PENDING",
    });
    expect(chip.getAttribute("data-row-status")).toBe("PENDING");
  });
});

describe("the dashed tint carries the text colour at 4.5:1", () => {
  const TOKENS = readTokensCss();
  const CODES = ["VACATION", "OVERTIME_COMP", "SICK", "SICK_CHILD", "SPECIAL", "UNPAID"];
  for (const name of Object.keys(SURFACES) as SurfaceName[]) {
    it(`${name}: --text on the tint of every type colour`, () => {
      const blocks = SURFACES[name];
      const card = cardSurface(TOKENS, blocks);
      for (const code of CODES) {
        const fill = leaveTypeColor(code).fill;
        const tint = over(
          resolveColor(TOKENS, blocks, `color-mix(in srgb, var(${fill}) 14%, transparent)`),
          card,
        );
        expect(
          contrast(resolveColor(TOKENS, blocks, "var(--text)"), tint),
          `${code} ${name}`,
        ).toBeGreaterThanOrEqual(4.5);
      }
    });
  }
});

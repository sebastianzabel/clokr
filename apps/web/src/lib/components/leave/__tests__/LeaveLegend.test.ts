// Issue #840 (D-840-10, D-840-25) — the one legend. It names only what it is given: the types by
// text with a swatch from the colour mapping, the bar styles, the markings, and the closed-day hint.
import { describe, it, expect } from "vitest";
import { screen } from "@testing-library/svelte";
import { renderWithTheme } from "$tests/test-utils";
import LeaveLegend from "../LeaveLegend.svelte";
import { CLOSED_DAYS_HINT_SEVERAL_SALONS } from "$lib/leave-plan/labels";
import { LEAVE_TYPES } from "$lib/leave/team-calendar-visibility";
import { MIXED, leaveTypeColor } from "$lib/leave/leave-colors";

type Props = {
  typeCodes: string[];
  styles: Array<"gesetzt" | "beantragt" | "wunsch" | "abwesend">;
  markings?: {
    weekend?: boolean;
    holiday?: boolean;
    closed?: boolean;
    today?: boolean;
    mixed?: boolean;
  };
  closedHint?: string | null;
  holidayLook?: "timeline" | "calendar";
};

function render(props: Props) {
  renderWithTheme(LeaveLegend, props as unknown as Record<string, unknown>);
  return screen.getByTestId("leave-legend");
}

const swatchOf = (el: HTMLElement) => el.querySelector<HTMLElement>(".legend-swatch")!;

describe("types", () => {
  it("renders one entry per given type: the name by text and the swatch of the mapping", () => {
    render({ typeCodes: ["VACATION", "SICK"], styles: [] });
    const vacation = screen.getByTestId("legend-type-VACATION");
    expect(vacation.textContent).toContain(LEAVE_TYPES.find((t) => t.code === "VACATION")!.label);
    expect(swatchOf(vacation).style.getPropertyValue("--swatch")).toBe(
      `var(${leaveTypeColor("VACATION").fill})`,
    );
    const sick = screen.getByTestId("legend-type-SICK");
    expect(sick.textContent).toContain("Krankmeldung");
    expect(swatchOf(sick).style.getPropertyValue("--swatch")).toBe(
      `var(${leaveTypeColor("SICK").fill})`,
    );
    expect(screen.queryByTestId("legend-type-PARENTAL")).toBeNull();
  });

  it("names an unknown code neutrally and draws the fallback swatch", () => {
    render({ typeCodes: ["NOT_A_CODE"], styles: [] });
    const entry = screen.getByTestId("legend-type-NOT_A_CODE");
    expect(entry.textContent).toContain("Andere Abwesenheit");
    expect(swatchOf(entry).style.getPropertyValue("--swatch")).toBe(
      `var(${leaveTypeColor("NOT_A_CODE").fill})`,
    );
  });

  it("an empty view (no types, no styles, no markings) shows an empty group, never a default list", () => {
    const legend = render({ typeCodes: [], styles: [] });
    expect(legend.querySelectorAll(".legend-item")).toHaveLength(0);
    expect(legend.textContent?.trim()).toBe("");
  });
});

describe("styles", () => {
  it("renders exactly the given styles, each with its own swatch shape", () => {
    render({ typeCodes: [], styles: ["beantragt", "wunsch"] });
    expect(screen.getByTestId("legend-style-beantragt").textContent).toContain("Beantragt");
    expect(screen.getByTestId("legend-style-wunsch").textContent).toContain("Wunsch");
    expect(swatchOf(screen.getByTestId("legend-style-beantragt")).className).toContain(
      "legend-swatch--beantragt",
    );
    expect(swatchOf(screen.getByTestId("legend-style-wunsch")).className).toContain(
      "legend-swatch--wunsch",
    );
    // Nothing for a style that is not given.
    expect(screen.queryByTestId("legend-style-gesetzt")).toBeNull();
    expect(screen.queryByTestId("legend-style-abwesend")).toBeNull();
  });

  it("the absent style is drawn with the neutral token of the mapping", () => {
    render({ typeCodes: [], styles: ["gesetzt", "abwesend"] });
    const absent = screen.getByTestId("legend-style-abwesend");
    expect(absent.textContent).toContain("Abwesend");
    expect(swatchOf(absent).style.getPropertyValue("--swatch")).toBe(
      `var(${leaveTypeColor(null).fill})`,
    );
    // #840 G-4: the style keys name the look and the status
    expect(screen.getByTestId("legend-style-gesetzt").textContent).toContain("Genehmigt (voll)");
  });

  it("names the four style keys with exactly the agreed texts", () => {
    render({ typeCodes: [], styles: ["gesetzt", "beantragt", "wunsch", "abwesend"] });
    const text = (style: string) => screen.getByTestId(`legend-style-${style}`).textContent;
    expect(text("gesetzt")).toBe("Genehmigt (voll)");
    expect(text("beantragt")).toBe("Beantragt (gestrichelt)");
    expect(text("wunsch")).toBe("Wunsch (gestreift)");
    expect(text("abwesend")).toBe("Abwesend");
  });

  it("draws voll and gestrichelt in the colour of the first type the legend names", () => {
    render({ typeCodes: ["SICK", "VACATION"], styles: ["gesetzt", "beantragt"] });
    const expected = `var(${leaveTypeColor("SICK").fill})`;
    for (const style of ["gesetzt", "beantragt"]) {
      expect(
        swatchOf(screen.getByTestId(`legend-style-${style}`)).style.getPropertyValue("--swatch"),
      ).toBe(expected);
    }
  });

  it("draws voll and gestrichelt in the brand colour when the legend names no type", () => {
    render({ typeCodes: [], styles: ["gesetzt", "beantragt"] });
    for (const style of ["gesetzt", "beantragt"]) {
      expect(
        swatchOf(screen.getByTestId(`legend-style-${style}`)).style.getPropertyValue("--swatch"),
      ).toBe("var(--brand)");
    }
  });
});

describe("markings and the closed-day hint", () => {
  it("renders only the markings that are given", () => {
    render({
      typeCodes: [],
      styles: [],
      markings: { weekend: true, holiday: true, today: true },
    });
    expect(screen.getByTestId("legend-marking-weekend").textContent).toContain("Wochenende");
    expect(screen.getByTestId("legend-marking-holiday").textContent).toContain("Feiertag");
    expect(screen.getByTestId("legend-marking-today").textContent).toContain("Heute");
    expect(screen.queryByTestId("legend-marking-closed")).toBeNull();
  });

  it("names the mixed Jahr look only when the host passes it", () => {
    render({ typeCodes: [], styles: [], markings: { mixed: true } });
    const entry = screen.getByTestId("legend-marking-mixed");
    expect(entry.textContent).toContain("Mehrere Arten");
    expect(swatchOf(entry).className).toContain("legend-swatch--mixed");
    expect(swatchOf(entry).style.getPropertyValue("--swatch")).toBe(`var(${MIXED.fill})`);
  });

  it("renders no mixed entry without markings.mixed", () => {
    render({ typeCodes: [], styles: [], markings: { weekend: true } });
    expect(screen.queryByTestId("legend-marking-mixed")).toBeNull();
    expect(screen.queryByText("Mehrere Arten")).toBeNull();
  });

  it("the holiday swatch follows the look of the host", () => {
    render({ typeCodes: [], styles: [], markings: { holiday: true }, holidayLook: "calendar" });
    expect(swatchOf(screen.getByTestId("legend-marking-holiday")).className).toContain(
      "legend-swatch--holiday-calendar",
    );
  });

  it("shows the closed marking and the hint as text when the host passes it", () => {
    render({
      typeCodes: [],
      styles: [],
      markings: { closed: true },
      closedHint: CLOSED_DAYS_HINT_SEVERAL_SALONS,
    });
    expect(screen.getByTestId("legend-marking-closed").textContent).toContain("Schließtag");
    expect(screen.getByTestId("legend-closed-hint").textContent).toBe(
      "Schließtage nur bei einem Salon",
    );
  });

  it("shows no hint element without a hint", () => {
    render({ typeCodes: [], styles: [], markings: { closed: true }, closedHint: null });
    expect(screen.queryByTestId("legend-closed-hint")).toBeNull();
  });
});

describe("accessibility", () => {
  it("is a labelled group and every swatch is hidden from assistive technology", () => {
    const legend = render({
      typeCodes: ["VACATION"],
      styles: ["beantragt"],
      markings: { weekend: true },
    });
    expect(legend.getAttribute("role")).toBe("group");
    expect(legend.getAttribute("aria-label")).toBe("Legende");
    const swatches = legend.querySelectorAll(".legend-swatch");
    expect(swatches.length).toBe(3);
    for (const swatch of swatches) expect(swatch.getAttribute("aria-hidden")).toBe("true");
  });
});

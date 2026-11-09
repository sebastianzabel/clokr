// Issue #843 (D-843-01 block 3) - the Kennzahlenleiste and its cell: structure, the band variant,
// the final figure under reduced motion, the container breakpoints, the band's contrast proof and
// the KPIStat delegation.
import { describe, expect, it } from "vitest";
import type { ComponentProps } from "svelte";
import { screen, within } from "@testing-library/svelte";
import { renderWithTheme } from "$tests/test-utils";
import {
  COMBINATIONS,
  contrast,
  over,
  readTokensCss,
  resolveColor,
  resolveCombination,
} from "$tests/token-cascade";
import KpiStrip from "../KpiStrip.svelte";
import KPIStat from "../KPIStat.svelte";
import stripSource from "../KpiStrip.svelte?raw";
import statSource from "../KPIStat.svelte?raw";
import { CONTAINER_NARROW_PX, CONTAINER_WIDE_PX } from "../breakpoints";

// #843: plain tsc types a .svelte import by the ambient default-only shim; take the item type from props.
type KpiItem = ComponentProps<typeof KpiStrip>["items"][number];

const ITEMS: KpiItem[] = [
  { label: "Soll", value: "160:00", unit: "h" },
  {
    label: "Ist",
    value: 152.5,
    format: (n: number) => `${n.toFixed(1).replace(".", ",")}`,
    unit: "h",
  },
  { label: "Saldo", value: "−7:30", explanation: "bis gestern", derivationHref: "/reports?x=1" },
];

describe("KpiStrip", () => {
  it("renders one cell per item with label, value, unit and explanation", () => {
    const { container } = renderWithTheme(KpiStrip, { items: ITEMS, ariaLabel: "Zeitkonto" });
    const cells = container.querySelectorAll("article.kpi");
    expect(cells).toHaveLength(3);
    expect([...container.querySelectorAll(".kpi-label")].map((e) => e.textContent)).toEqual([
      "Soll",
      "Ist",
      "Saldo",
    ]);
    expect(cells[0].querySelector(".kpi-unit")?.textContent?.trim()).toBe("h");
    expect(cells[2].querySelector(".kpi-unit")).toBeNull();
    expect(cells[2].querySelector(".kpi-explanation")?.textContent).toBe("bis gestern");
    expect(cells[0].querySelector(".kpi-explanation")).toBeNull();
    expect(screen.getByRole("group", { name: "Zeitkonto" })).toBeInTheDocument();
  });

  it("renders the Herleitung link only when derivationHref is set", () => {
    renderWithTheme(KpiStrip, { items: ITEMS });
    const links = screen.getAllByRole("link", { name: "Herleitung →" });
    expect(links).toHaveLength(1);
    expect(links[0]).toHaveAttribute("href", "/reports?x=1");
  });

  it("tints the strip only with band", () => {
    const plain = renderWithTheme(KpiStrip, { items: ITEMS });
    expect(plain.container.querySelector(".kpi-strip")).not.toHaveClass("kpi-strip--band");
    plain.unmount();
    const banded = renderWithTheme(KpiStrip, { items: ITEMS, band: true });
    expect(banded.container.querySelector(".kpi-strip")).toHaveClass("kpi-strip--band");
  });

  it("shows the final formatted figure at once in jsdom (reduced motion): never an intermediate number", () => {
    const { container } = renderWithTheme(KpiStrip, { items: ITEMS });
    const value = container.querySelectorAll(".kpi-value")[1];
    // The figure is the first text node of the value line, the unit stays its own element.
    expect(value.firstChild?.nodeType).toBe(Node.TEXT_NODE);
    expect(value.firstChild?.textContent?.trim()).toBe("152,5");
    expect(value.querySelector(".kpi-unit")?.textContent?.trim()).toBe("h");
  });

  it("is a size container with exactly the two block breakpoints", () => {
    expect(stripSource).toMatch(/container-type:\s*inline-size/);
    const queries = [...stripSource.matchAll(/@container \(min-width: (\d+)px\)/g)].map((m) =>
      Number(m[1]),
    );
    expect(queries).toEqual([CONTAINER_NARROW_PX, CONTAINER_WIDE_PX]);
    expect(stripSource).toMatch(/minmax\(160px, 1fr\)/);
    expect(stripSource).not.toMatch(/@media/);
  });
});

describe("KpiStrip band contrast (--brand-tint)", () => {
  const css = readTokensCss();
  it("uses --brand-tint for the band and every text pair on it reaches 4.5:1 in all six combinations", () => {
    expect(stripSource).toMatch(/\.kpi-strip--band\s*\{\s*background:\s*var\(--brand-tint\)/);
    expect(COMBINATIONS).toHaveLength(6);
    const failures: string[] = [];
    for (const combo of COMBINATIONS) {
      const map = resolveCombination(css, combo.theme, combo.mode);
      const page = resolveColor(map, "var(--bg)");
      const back = over(resolveColor(map, "var(--brand-tint)"), page);
      // label (text-2 in the band), value (text), explanation (text-2), link (brand), delta tones
      for (const fg of ["text", "text-2", "brand", "ok", "warn", "bad"]) {
        const r = contrast(over(resolveColor(map, `var(--${fg})`), back), back);
        if (r < 4.5) failures.push(`${combo.theme}/${combo.mode} ${fg} ${r.toFixed(2)}`);
      }
    }
    expect(failures).toEqual([]);
  });
});

describe("KPIStat delegates to the cell", () => {
  it("source renders <KpiCell", () => {
    expect(statSource).toContain("<KpiCell");
    expect(statSource).not.toContain("<article");
  });

  it("keeps its classes, texts and the progress bar", () => {
    const { container } = renderWithTheme(KPIStat, {
      label: "Urlaub",
      value: "12",
      unit: "von 30",
      delta: "+3,5 h",
      deltaTone: "warn",
      progress: { value: 12, max: 30, label: "12 von 30 Tagen" },
    });
    const article = container.querySelector("article.kpi") as HTMLElement;
    expect(article).not.toBeNull();
    expect(article).not.toHaveClass("kpi-cell--strip");
    expect(within(article).getByText("Urlaub")).toHaveClass("kpi-label");
    expect(article.querySelector(".kpi-value")?.firstChild?.textContent?.trim()).toBe("12");
    expect(article.querySelector(".kpi-unit")?.textContent?.trim()).toBe("von 30");
    expect(article.querySelector(".kpi-delta.kpi-delta-warn")?.textContent).toBe("+3,5 h");
    const bar = within(article).getByRole("progressbar", { name: "12 von 30 Tagen" });
    expect(bar).toHaveAttribute("aria-valuenow", "12");
    expect(bar.querySelector(".kpi-progress-fill")).not.toHaveClass("kpi-progress-fill-full");
  });

  it("renders a plain delta without a tone class", () => {
    const { container } = renderWithTheme(KPIStat, { label: "A", value: "1", delta: "x" });
    const delta = container.querySelector(".kpi-delta") as HTMLElement;
    expect([...delta.classList].filter((c) => c.startsWith("kpi-"))).toEqual(["kpi-delta"]);
  });
});

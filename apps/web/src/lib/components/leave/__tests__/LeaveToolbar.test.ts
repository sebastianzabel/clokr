// Issue #840 (D-840-13, E-01) — LeaveToolbar: tabs (ARIA, roving tabindex, arrow keys), zoom
// radiogroup, the optional period switcher and the filters snippet.

import { describe, it, expect, vi } from "vitest";
import { createRawSnippet } from "svelte";
import { screen, fireEvent } from "@testing-library/svelte";
import {
  SURFACES,
  cardSurface,
  contrast,
  over,
  readAppCss,
  readTokensCss,
  resolveColor,
  type SurfaceName,
} from "../../../../__tests__/token-css";
import { renderWithTheme } from "$tests/test-utils";
import { periodOf } from "$lib/leave/timeline-model";
import LeaveToolbar from "../LeaveToolbar.svelte";

const TABS = [
  { id: "uebersicht", label: "Übersicht" },
  { id: "antraege", label: "Anträge", badge: 3, testId: "view-list" },
  { id: "planung", label: "Planung" },
];

function render(overrides: Record<string, unknown> = {}) {
  const props = {
    ariaLabel: "Bereich Abwesenheiten",
    tabs: TABS,
    activeTab: "uebersicht",
    onTabChange: vi.fn(),
    ...overrides,
  };
  renderWithTheme(LeaveToolbar, props);
  return props;
}

describe("tabs", () => {
  it("renders a tablist with one tab per entry, the active one selected and the only tab stop", () => {
    render();
    const list = screen.getByRole("tablist", { name: "Bereich Abwesenheiten" });
    const tabs = screen.getAllByRole("tab");
    expect(list).toBeTruthy();
    expect(tabs.map((t) => t.textContent?.trim())).toEqual(["Übersicht", "Anträge 3", "Planung"]);
    expect(tabs.map((t) => t.getAttribute("aria-selected"))).toEqual(["true", "false", "false"]);
    expect(tabs.map((t) => t.getAttribute("tabindex"))).toEqual(["0", "-1", "-1"]);
    expect(tabs[0].id).toBe("leave-tab-uebersicht");
    expect(tabs[0].getAttribute("aria-controls")).toBe("leave-panel-uebersicht");
  });

  it("shows a badge only when given", () => {
    render();
    const badges = document.querySelectorAll(".tab-badge");
    expect(badges).toHaveLength(1);
    expect(badges[0].textContent).toBe("3");
  });

  it("a click calls onTabChange with the id", async () => {
    const p = render();
    await fireEvent.click(screen.getByRole("tab", { name: /Planung/ }));
    expect(p.onTabChange).toHaveBeenCalledWith("planung");
  });

  it("ArrowRight, ArrowLeft (both wrap), Home and End move the selection", async () => {
    const p = render({ activeTab: "planung" });
    const list = screen.getByRole("tablist");
    await fireEvent.keyDown(list, { key: "ArrowRight" });
    expect(p.onTabChange).toHaveBeenLastCalledWith("uebersicht");
    await fireEvent.keyDown(list, { key: "ArrowLeft" });
    expect(p.onTabChange).toHaveBeenLastCalledWith("antraege");
    await fireEvent.keyDown(list, { key: "Home" });
    expect(p.onTabChange).toHaveBeenLastCalledWith("uebersicht");
    await fireEvent.keyDown(list, { key: "End" });
    expect(p.onTabChange).toHaveBeenLastCalledWith("planung");
  });

  it("moves the focus with the selection and ignores other keys", async () => {
    const p = render();
    const list = screen.getByRole("tablist");
    await fireEvent.keyDown(list, { key: "ArrowRight" });
    expect(document.activeElement).toBe(screen.getByRole("tab", { name: /Anträge/ }));
    await fireEvent.keyDown(list, { key: "a" });
    expect(p.onTabChange).toHaveBeenCalledTimes(1);
  });

  it("renders no tablist without tabs", () => {
    render({ tabs: [] });
    expect(screen.queryByRole("tablist")).toBeNull();
  });
});

describe("test ids", () => {
  it("carries the prefixed ids with testIdPrefix, a tab's own testId winning over its id", () => {
    render({ testIdPrefix: "leave-team" });
    expect(screen.getByTestId("leave-team-tabs")).toBeTruthy();
    expect(screen.getByTestId("leave-team-uebersicht")).toBeTruthy();
    expect(screen.getByTestId("leave-team-view-list")).toBe(screen.getAllByRole("tab")[1]);
  });

  it("carries none without testIdPrefix", () => {
    render();
    expect(document.querySelector("[data-testid]")).toBeNull();
  });
});

describe("zoom", () => {
  it("is a radiogroup with only the given zooms, the current one checked", () => {
    render({ zooms: ["quartal", "monat"], zoom: "quartal" });
    const group = screen.getByRole("radiogroup", { name: "Zeitraum" });
    const radios = screen.getAllByRole("radio");
    expect(group).toBeTruthy();
    expect(radios.map((r) => r.textContent?.trim())).toEqual(["Quartal", "Monat"]);
    expect(radios.map((r) => r.getAttribute("aria-checked"))).toEqual(["true", "false"]);
  });

  it("calls onZoomChange with the zoom code", async () => {
    const onZoomChange = vi.fn();
    render({ zooms: ["jahr", "quartal", "monat"], zoom: "quartal", onZoomChange });
    await fireEvent.click(screen.getByRole("radio", { name: "Jahr" }));
    expect(onZoomChange).toHaveBeenCalledWith("jahr");
  });

  it("is absent without zooms", () => {
    render();
    expect(screen.queryByRole("radiogroup")).toBeNull();
  });
});

describe("period switcher and filters", () => {
  it("shows no period switcher without a period", () => {
    render();
    expect(document.querySelector(".month-bar")).toBeNull();
  });

  it("wires the period switcher to onShift and onToday", async () => {
    const onShift = vi.fn();
    const onToday = vi.fn();
    render({ period: periodOf("quartal", "2026-11-08"), onShift, onToday });
    expect(screen.getByTestId("month-bar-label")).toHaveTextContent("Q4 2026 · Okt–Dez");
    await fireEvent.click(screen.getByTestId("month-bar-prev"));
    await fireEvent.click(screen.getByTestId("month-bar-next"));
    await fireEvent.click(screen.getByRole("button", { name: "Heute" }));
    expect(onShift).toHaveBeenNthCalledWith(1, -1);
    expect(onShift).toHaveBeenNthCalledWith(2, 1);
    expect(onToday).toHaveBeenCalledTimes(1);
  });

  it("renders the filters snippet inside the toolbar", () => {
    const filters = createRawSnippet(() => ({
      render: () => '<label data-testid="own-filter">Salon</label>',
    }));
    render({ filters });
    const toolbar = document.querySelector(".leave-toolbar")!;
    expect(toolbar.contains(screen.getByTestId("own-filter"))).toBe(true);
  });
});

describe("the neutral count (#840 G-1)", () => {
  const COUNT_TABS = [
    { id: "uebersicht", label: "Übersicht" },
    {
      id: "antraege",
      label: "Anträge",
      badge: 2,
      badgeLabel: "2 offen: 2 Anträge",
      testId: "view-list",
    },
  ];

  it("draws the count neutral, hidden from the tree and titled with the explanation", () => {
    render({ tabs: COUNT_TABS, testIdPrefix: "leave-team" });
    const count = screen.getByTestId("leave-team-view-list-badge");
    expect(count.textContent).toBe("2");
    expect(count.classList.contains("tab-badge")).toBe(true);
    expect(count.classList.contains("tab-badge--count")).toBe(true);
    expect(count.getAttribute("title")).toBe("2 offen: 2 Anträge");
    expect(count.getAttribute("aria-hidden")).toBe("true");
  });

  it("puts the explanation into the accessible name of the tab", () => {
    render({ tabs: COUNT_TABS });
    expect(screen.getByRole("tab", { name: /2 offen: 2 Anträge/ })).toBeTruthy();
  });

  it("a click on the count calls onBadgeSelect and not onTabChange", async () => {
    const onBadgeSelect = vi.fn();
    const tabs = [COUNT_TABS[0], { ...COUNT_TABS[1], onBadgeSelect }];
    const p = render({ tabs, testIdPrefix: "leave-team" });
    await fireEvent.click(screen.getByTestId("leave-team-view-list-badge"));
    expect(onBadgeSelect).toHaveBeenCalledTimes(1);
    expect(p.onTabChange).not.toHaveBeenCalled();
  });

  it("a click on the tab label still calls onTabChange, and keyboard keeps doing so", async () => {
    const onBadgeSelect = vi.fn();
    const tabs = [COUNT_TABS[0], { ...COUNT_TABS[1], onBadgeSelect }];
    const p = render({ tabs });
    await fireEvent.click(screen.getByRole("tab", { name: /Anträge/ }));
    expect(p.onTabChange).toHaveBeenCalledWith("antraege");
    await fireEvent.keyDown(screen.getByRole("tablist"), { key: "ArrowRight" });
    expect(p.onTabChange).toHaveBeenLastCalledWith("antraege");
    expect(onBadgeSelect).not.toHaveBeenCalled();
  });

  it("a count without a handler is still a plain tab click", async () => {
    const p = render({ tabs: COUNT_TABS, testIdPrefix: "leave-team" });
    await fireEvent.click(screen.getByTestId("leave-team-view-list-badge"));
    expect(p.onTabChange).toHaveBeenCalledWith("antraege");
  });

  describe("the neutral pair reaches 4.5:1 in every surface mode", () => {
    const APP_CSS = readAppCss();
    const TOKENS = readTokensCss();
    const body = /\.tab-badge--count\s*\{([^}]*)\}/.exec(APP_CSS)?.[1] ?? "";
    const declared = (prop: string) =>
      new RegExp(`(?:^|[;\\s])${prop}\\s*:\\s*([^;]+);`).exec(body)?.[1].trim();

    it("declares a text and a background colour", () => {
      expect(declared("color")).toBeTruthy();
      expect(declared("background")).toBeTruthy();
    });

    for (const name of Object.keys(SURFACES) as SurfaceName[]) {
      it(`${name}: the count text on its pill`, () => {
        const blocks = SURFACES[name];
        const card = cardSurface(TOKENS, blocks);
        const pill = over(resolveColor(TOKENS, blocks, declared("background")!), card);
        const text = over(resolveColor(TOKENS, blocks, declared("color")!), pill);
        expect(contrast(text, pill)).toBeGreaterThanOrEqual(4.5);
      });
    }
  });
});

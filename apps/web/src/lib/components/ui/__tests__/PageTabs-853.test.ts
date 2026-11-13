// Issue #853 (D-853-05, D-853-11) - PageTabs in link mode (a route per tab) and the #840 tab
// contract (test ids, badge, badge click target) in panel mode.
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, screen } from "@testing-library/svelte";
import { createRawSnippet } from "svelte";
import { renderWithTheme } from "$tests/test-utils";
import PageTabs from "../PageTabs.svelte";

afterEach(() => cleanup());

const panel = createRawSnippet((value: () => string) => ({
  render: () => `<p>Inhalt ${value()}</p>`,
}));

const linkTabs = [
  { value: "plan", label: "Planung", href: "/team/dienstplan" },
  { value: "vorlagen", label: "Vorlagen", href: "/team/dienstplan/vorlagen" },
  { value: "hinweise", label: "Hinweise", href: "/team/dienstplan/konflikte", badge: 3 },
];

describe("PageTabs - link mode", () => {
  it("renders a nav with one anchor per tab and no ARIA tablist or panel", () => {
    const { container } = renderWithTheme(PageTabs, {
      tabs: linkTabs,
      tab: "vorlagen",
      tabsLabel: "Dienstplan",
    });
    const nav = screen.getByRole("navigation", { name: "Dienstplan" });
    const anchors = nav.querySelectorAll("a");
    expect([...anchors].map((a) => a.getAttribute("href"))).toEqual([
      "/team/dienstplan",
      "/team/dienstplan/vorlagen",
      "/team/dienstplan/konflikte",
    ]);
    expect(screen.queryByRole("tablist")).toBeNull();
    expect(screen.queryByRole("tab")).toBeNull();
    expect(screen.queryByRole("tabpanel")).toBeNull();
    expect(container.querySelector("[role]")).toBeNull();
  });

  it("marks exactly the current tab with aria-current=page", () => {
    const { container } = renderWithTheme(PageTabs, { tabs: linkTabs, tab: "vorlagen" });
    const current = container.querySelectorAll('[aria-current="page"]');
    expect(current).toHaveLength(1);
    expect(current[0].textContent).toContain("Vorlagen");
  });

  it("falls back to the first tab while nothing is bound", () => {
    const { container } = renderWithTheme(PageTabs, { tabs: linkTabs });
    expect(container.querySelector('[aria-current="page"]')!.textContent).toContain("Planung");
  });

  it("carries the test ids and shows a count badge", () => {
    renderWithTheme(PageTabs, { tabs: linkTabs, tab: "plan", testIdPrefix: "team" });
    expect(screen.getByTestId("team-tabs")).toBeTruthy();
    expect(screen.getByTestId("team-plan")).toBeTruthy();
    expect(screen.getByTestId("team-hinweise").textContent).toContain("3");
  });

  it("a tab without an href switches back to panel mode", () => {
    renderWithTheme(PageTabs, {
      tabs: [
        { value: "a", label: "A", href: "/a" },
        { value: "b", label: "B" },
      ],
      panel,
    });
    expect(screen.getByRole("tablist")).toBeTruthy();
  });

  it("a passed panel keeps panel mode even when every tab has an href", () => {
    renderWithTheme(PageTabs, { tabs: linkTabs, panel });
    expect(screen.getByRole("tablist")).toBeTruthy();
    expect(screen.queryByRole("navigation")).toBeNull();
  });
});

describe("PageTabs - panel mode test-id and badge contract (#840)", () => {
  function tabs(onBadgeSelect: () => void) {
    return [
      { value: "alle", label: "Alle" },
      {
        value: "antraege",
        label: "Anträge",
        testId: "requests",
        badge: 4,
        badgeLabel: "4 offene Anträge",
        onBadgeSelect,
      },
    ];
  }

  it("exposes <prefix>-tabs, <prefix>-<tab> and <prefix>-<tab>-badge", () => {
    renderWithTheme(PageTabs, {
      tabs: tabs(() => {}),
      panel,
      testIdPrefix: "leave-team-view",
    });
    expect(screen.getByTestId("leave-team-view-tabs").getAttribute("role")).toBe("tablist");
    expect(screen.getByTestId("leave-team-view-alle").getAttribute("role")).toBe("tab");
    expect(screen.getByTestId("leave-team-view-requests").textContent).toContain("Anträge");
    const badge = screen.getByTestId("leave-team-view-requests-badge");
    expect(badge.textContent).toBe("4");
    expect(badge.hasAttribute("data-tab-count")).toBe(true);
    expect(badge.getAttribute("title")).toBe("4 offene Anträge");
    expect(screen.getByText("4 offene Anträge", { selector: ".page-tab-sr" })).toBeTruthy();
  });

  it("renders no test ids without a prefix", () => {
    const { container } = renderWithTheme(PageTabs, { tabs: tabs(() => {}), panel });
    expect(container.querySelector("[data-testid]")).toBeNull();
  });

  it("a click on the badge selects the tab and calls onBadgeSelect once", async () => {
    const onBadgeSelect = vi.fn();
    const onTabChange = vi.fn();
    renderWithTheme(PageTabs, {
      tabs: tabs(onBadgeSelect),
      panel,
      testIdPrefix: "t",
      onTabChange,
    });
    await fireEvent.click(screen.getByTestId("t-requests-badge"));
    expect(onBadgeSelect).toHaveBeenCalledTimes(1);
    expect(onTabChange).toHaveBeenCalledWith("antraege");
    expect(screen.getByTestId("t-requests").getAttribute("aria-selected")).toBe("true");
  });

  it("a click elsewhere on the trigger does not call onBadgeSelect", async () => {
    const onBadgeSelect = vi.fn();
    renderWithTheme(PageTabs, { tabs: tabs(onBadgeSelect), panel, testIdPrefix: "t" });
    await fireEvent.click(screen.getByTestId("t-requests"));
    expect(onBadgeSelect).not.toHaveBeenCalled();
    expect(screen.getByTestId("t-requests").getAttribute("aria-selected")).toBe("true");
  });

  it("a badge without onBadgeSelect is just a count", async () => {
    renderWithTheme(PageTabs, {
      tabs: [
        { value: "a", label: "A", badge: 2 },
        { value: "b", label: "B" },
      ],
      panel,
    });
    expect(screen.getByRole("tab", { name: /^A/ }).textContent).toContain("2");
  });
});

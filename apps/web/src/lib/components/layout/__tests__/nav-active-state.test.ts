// Issue #515 — the navigation marks the current location programmatically (aria-current), not by
// colour alone, in the mobile/tablet variants. The desktop Sidebar imports `$app/navigation`, which
// the component-test config cannot resolve (see version-line.test.ts), so it is covered by the e2e
// test "navigation is clear" and by the one-place source guard instead; BottomTabBar and
// MobileMoreSheet have no `$app` import and are mounted here.

import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { beforeEach, describe, expect, it, vi } from "vitest";
import { screen, within } from "@testing-library/svelte";

// Mounting pulls in $stores/auth -> $app/environment transitively, which the config does not
// resolve; replacing the whole module with a writable store lets each test choose the user
// (same idiom as version-line.test.ts, plus a settable value because the tab bar reads the
// permissions and role).
vi.mock("$stores/auth", async () => {
  const { writable } = await import("svelte/store");
  return { authStore: writable({ user: null }) };
});

import { renderWithTheme } from "$tests/test-utils";
import { authStore } from "$stores/auth";
import BottomTabBar from "../BottomTabBar.svelte";
import MobileMoreSheet from "../MobileMoreSheet.svelte";

function readComponentFile(relativeFromHere: string, relativeFromCwd: string): string {
  try {
    return readFileSync(fileURLToPath(new URL(relativeFromHere, import.meta.url)), "utf8");
  } catch {
    // Fallback: `pnpm --filter @clokr/web test` runs with cwd `apps/web`.
    return readFileSync(resolve(process.cwd(), relativeFromCwd), "utf8");
  }
}

const BOTTOM_TAB_BAR = readComponentFile(
  "../BottomTabBar.svelte",
  "src/lib/components/layout/BottomTabBar.svelte",
);
const MOBILE_MORE_SHEET = readComponentFile(
  "../MobileMoreSheet.svelte",
  "src/lib/components/layout/MobileMoreSheet.svelte",
);

const ALL_TEAM_PERMISSIONS = [
  "leave-request:approve:ZUGEWIESEN",
  "retro-request:approve:ZUGEWIESEN",
  "time-entry:read:ZUGEWIESEN",
  "leave-request:read:ZUGEWIESEN",
  "shift:plan:ZUGEWIESEN",
  "report:read:ZUGEWIESEN",
];

function signInAs(permissions: string[]) {
  // The store is mocked with a plain writable, so the user shape is only what the tab bar reads.
  (authStore as unknown as { set(v: unknown): void }).set({ user: { permissions } });
}

function mobileNav(): HTMLElement {
  // `hidden: true`: the bar is display:none above 960px by component CSS, and jsdom applies it.
  return screen.getByRole("navigation", { name: "Hauptnavigation (mobil)", hidden: true });
}

function currentElements(nav: HTMLElement): Element[] {
  return Array.from(nav.querySelectorAll("[aria-current]"));
}

describe("BottomTabBar — current location (#515)", () => {
  beforeEach(() => {
    // Since #83 the admin items behind „Mehr“ are permission-gated (since #844 by the route table), so the
    // fixture also holds the right its Personen page needs. Without team-overview:read the Salon tab is skipped,
    // so the team variant shows Aufgaben · Mein Tag · Abwesend · Mehr (#844, D-844-13).
    signInAs([...ALL_TEAM_PERMISSIONS, "employee:read:ZUGEWIESEN"]);
  });

  it("marks a primary route as the page and leaves Mehr unmarked, named exactly Mehr", () => {
    renderWithTheme(BottomTabBar, { currentPath: "/team/aufgaben" });
    const nav = mobileNav();

    const current = currentElements(nav);
    expect(current).toHaveLength(1);
    const tasks = within(nav).getByRole("link", { name: "Aufgaben", hidden: true });
    expect(current[0]).toBe(tasks);
    expect(tasks).toHaveAttribute("aria-current", "page");

    const mehr = within(nav).getByRole("button", { name: "Mehr", hidden: true });
    expect(mehr).not.toHaveAttribute("aria-current");
    expect(mehr).toHaveAccessibleName("Mehr");
  });

  it("marks the Mehr trigger when the page lives behind Mehr (Verwalten route)", () => {
    renderWithTheme(BottomTabBar, { currentPath: "/verwalten/personen" });
    const nav = mobileNav();

    expect(within(nav).queryAllByRole("link", { hidden: true }).filter(isCurrent)).toHaveLength(0);
    const mehr = within(nav).getByRole("button", { hidden: true });
    expect(mehr).toHaveAttribute("aria-current", "true");
    expect(mehr).toHaveClass("tab-active");
    expect(mehr).toHaveAccessibleName("Mehr, aktuelle Seite: Personen");
    expect(currentElements(nav)).toHaveLength(1);
  });

  it("on the team variant the own times live behind Mehr, and no tab is marked for them", () => {
    renderWithTheme(BottomTabBar, { currentPath: "/ich/zeiten" });
    const nav = mobileNav();

    expect(within(nav).queryByRole("link", { name: "Zeiten", hidden: true })).toBeNull();
    const mehr = within(nav).getByRole("button", { hidden: true });
    expect(mehr).toHaveAttribute("aria-current", "true");
    expect(mehr).toHaveAccessibleName("Mehr, aktuelle Seite: Zeiten");
    expect(currentElements(nav)).toHaveLength(1);
  });

  it("a plain employee has the personal tabs, and the profile behind Mehr", () => {
    signInAs([]);
    renderWithTheme(BottomTabBar, { currentPath: "/ich/zeiten" });
    const nav = mobileNav();
    expect(within(nav).getByRole("link", { name: "Zeiten", hidden: true })).toHaveAttribute(
      "aria-current",
      "page",
    );
  });

  it("names the page behind Mehr for a plain employee too", () => {
    signInAs([]);
    renderWithTheme(BottomTabBar, { currentPath: "/ich/profil" });
    const nav = mobileNav();

    const mehr = within(nav).getByRole("button", { hidden: true });
    expect(mehr).toHaveAttribute("aria-current", "true");
    expect(mehr).toHaveAccessibleName("Mehr, aktuelle Seite: Profil");
  });

  it("marks nothing on an unknown route and keeps the plain Mehr name", () => {
    renderWithTheme(BottomTabBar, { currentPath: "/nowhere" });
    const nav = mobileNav();

    expect(currentElements(nav)).toHaveLength(0);
    expect(within(nav).getByRole("button", { hidden: true })).toHaveAccessibleName("Mehr");
  });
});

function isCurrent(el: Element): boolean {
  return el.hasAttribute("aria-current");
}

describe("MobileMoreSheet — current page (#515)", () => {
  const sections = [
    {
      area: "verwalten" as const,
      label: "Verwalten",
      items: [
        {
          href: "/verwalten/personen",
          label: "Mitarbeitende",
          icon: "users",
          testId: "nav-admin-employees",
        },
        {
          href: "/verwalten/regeln/urlaub",
          label: "Urlaubsverwaltung",
          icon: "umbrella",
          testId: "nav-admin-vacation",
        },
      ],
    },
  ];

  function sheetDialog(): HTMLElement {
    return screen.getByRole("dialog", { name: "Weitere Navigation" });
  }

  it("marks only the link that is the page, also from a nested path", () => {
    renderWithTheme(MobileMoreSheet, {
      open: true,
      sections,
      currentPath: "/verwalten/personen/abc",
    });
    const dialog = sheetDialog();

    expect(dialog.querySelectorAll("[aria-current]")).toHaveLength(1);
    expect(within(dialog).getByRole("link", { name: "Mitarbeitende" })).toHaveAttribute(
      "aria-current",
      "page",
    );
    expect(within(dialog).getByRole("link", { name: "Urlaubsverwaltung" })).not.toHaveAttribute(
      "aria-current",
    );
  });

  it("follows the current path to the other item", () => {
    renderWithTheme(MobileMoreSheet, {
      open: true,
      sections,
      currentPath: "/verwalten/regeln/urlaub",
    });
    const dialog = sheetDialog();

    expect(within(dialog).getByRole("link", { name: "Urlaubsverwaltung" })).toHaveAttribute(
      "aria-current",
      "page",
    );
    expect(within(dialog).getByRole("link", { name: "Mitarbeitende" })).not.toHaveAttribute(
      "aria-current",
    );
  });

  it("marks nothing when the path is none of the items", () => {
    renderWithTheme(MobileMoreSheet, { open: true, sections, currentPath: "/ich/tag" });

    expect(sheetDialog().querySelectorAll("[aria-current]")).toHaveLength(0);
  });
});

// The sheet stays closed in the e2e test and a stylesheet rule is not observable in jsdom, so the
// non-colour cue (WCAG 1.4.1) of both variants is pinned at the source.
describe("non-colour marking of the current item (#515)", () => {
  it("the tab bar draws a ::before bar on the current tab", () => {
    expect(BOTTOM_TAB_BAR).toContain(".tab[aria-current]::before");
  });

  it("the Mehr sheet draws a ::before bar on the current item", () => {
    expect(MOBILE_MORE_SHEET).toContain('.mehr-item[aria-current="page"]::before');
  });
});

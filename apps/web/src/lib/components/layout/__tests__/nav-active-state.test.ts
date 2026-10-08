// Issue #515 — the navigation marks the current location programmatically (aria-current), not by
// colour alone, in the mobile/tablet variants. The desktop Sidebar imports `$app/navigation`, which
// the component-test config cannot resolve (see version-line.test.ts), so it is covered by the e2e
// test "navigation is clear" and by the one-place source guard instead; BottomTabBar and
// MobileMoreSheet have no `$app` import and are mounted here.

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

const ALL_TEAM_PERMISSIONS = [
  "leave-request:approve:ZUGEWIESEN",
  "retro-request:approve:ZUGEWIESEN",
  "time-entry:read:ZUGEWIESEN",
  "leave-request:read:ZUGEWIESEN",
  "shift:plan:ZUGEWIESEN",
  "report:read:ZUGEWIESEN",
];

function signInAs(role: "ADMIN" | "EMPLOYEE", permissions: string[]) {
  // The store is mocked with a plain writable, so the user shape is only what the tab bar reads.
  (authStore as unknown as { set(v: unknown): void }).set({ user: { role, permissions } });
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
    signInAs("ADMIN", ALL_TEAM_PERMISSIONS);
  });

  it("marks a primary route as the page and leaves Mehr unmarked, named exactly Mehr", () => {
    renderWithTheme(BottomTabBar, { currentPath: "/time-entries" });
    const nav = mobileNav();

    const current = currentElements(nav);
    expect(current).toHaveLength(1);
    const zeit = within(nav).getByRole("link", { name: "Zeit", hidden: true });
    expect(current[0]).toBe(zeit);
    expect(zeit).toHaveAttribute("aria-current", "page");

    const mehr = within(nav).getByRole("button", { name: "Mehr", hidden: true });
    expect(mehr).not.toHaveAttribute("aria-current");
    expect(mehr).toHaveAccessibleName("Mehr");
  });

  it("marks the Mehr trigger when the page lives behind Mehr (admin route)", () => {
    renderWithTheme(BottomTabBar, { currentPath: "/admin/employees" });
    const nav = mobileNav();

    expect(within(nav).queryAllByRole("link", { hidden: true }).filter(isCurrent)).toHaveLength(0);
    const mehr = within(nav).getByRole("button", { hidden: true });
    expect(mehr).toHaveAttribute("aria-current", "true");
    expect(mehr).toHaveClass("tab-active");
    expect(mehr).toHaveAccessibleName("Mehr, aktuelle Seite: Mitarbeitende");
    expect(currentElements(nav)).toHaveLength(1);
  });

  it("does not mark the personal Zeit tab on the team variant, marks Mehr instead", () => {
    renderWithTheme(BottomTabBar, { currentPath: "/team/time-entries" });
    const nav = mobileNav();

    const zeit = within(nav).getByRole("link", { name: "Zeit", hidden: true });
    expect(zeit).not.toHaveAttribute("aria-current");
    const mehr = within(nav).getByRole("button", { hidden: true });
    expect(mehr).toHaveAttribute("aria-current", "true");
    expect(mehr).toHaveAccessibleName("Mehr, aktuelle Seite: Team-Zeiten");
    expect(currentElements(nav)).toHaveLength(1);
  });

  it("names the page behind Mehr for a plain employee too", () => {
    signInAs("EMPLOYEE", []);
    renderWithTheme(BottomTabBar, { currentPath: "/settings" });
    const nav = mobileNav();

    const mehr = within(nav).getByRole("button", { hidden: true });
    expect(mehr).toHaveAttribute("aria-current", "true");
    expect(mehr).toHaveAccessibleName("Mehr, aktuelle Seite: Mein Profil");
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

// Issue #516 — the desktop sidebar and the mobile "Mehr" sheet offer the same targets under the
// same headings, because both render `visibleNavSections()` ($lib/nav/app-nav) and nothing else.
// The pure function is tested per persona (a permission-based visibility change stays visible
// here), the mobile variant is mounted for each persona, and the desktop Sidebar - which imports
// `$app/navigation` and cannot be mounted (see nav-active-state.test.ts) - is pinned at the source.

import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, screen, within } from "@testing-library/svelte";

vi.mock("$stores/auth", async () => {
  const { writable } = await import("svelte/store");
  return { authStore: writable({ user: null }) };
});

import { renderWithTheme } from "$tests/test-utils";
import { authStore } from "$stores/auth";
import { tenantFeatures } from "$stores/tenant-features";
import { visibleNavSections } from "$lib/nav/app-nav";
import { ADMIN_ROUTE_PERMISSIONS } from "$lib/nav/admin-route-permissions";
import personas from "$lib/nav/__tests__/fixtures/system-role-permissions.json";
import BottomTabBar from "../BottomTabBar.svelte";

function read(relativeFromHere: string, relativeFromCwd: string): string {
  try {
    return readFileSync(fileURLToPath(new URL(relativeFromHere, import.meta.url)), "utf8");
  } catch {
    return readFileSync(resolve(process.cwd(), relativeFromCwd), "utf8");
  }
}

const p = personas as Record<string, string[]>;
const on = { availabilityEnabled: true };
const hrefsOf = (sections: { items: { href: string }[] }[]) =>
  sections.flatMap((s) => s.items.map((i) => i.href));

describe("visibleNavSections — the one definition (#516)", () => {
  it("shows the personal, team and admin targets of an admin under the sidebar headings", () => {
    const sections = visibleNavSections({ permissions: p.ADMIN }, on);
    expect(sections.map((s) => s.label)).toEqual([
      "Mein Bereich",
      "Team",
      "PERSONAL",
      "PLANUNG",
      "COMPLIANCE",
      "DATEN",
      "SYSTEM",
    ]);
    const hrefs = hrefsOf(sections);
    // The two admin targets that were missing on mobile, and the personal one with the same label.
    for (const href of ["/admin/availability", "/admin/phorest", "/availability"]) {
      expect(hrefs).toContain(href);
    }
    // Every navigable admin route is offered, a redirect-only one never.
    for (const entry of ADMIN_ROUTE_PERMISSIONS) {
      expect(hrefs.includes(entry.href), entry.href).toBe(entry.inNav);
    }
    expect(hrefs).not.toContain("/admin/special-leave");
    expect(hrefs).not.toContain("/admin/wifi-presence");
  });

  it("lists no target twice and keeps the two Verfügbarkeit entries under different headings", () => {
    const sections = visibleNavSections({ permissions: p.ADMIN }, on);
    const hrefs = hrefsOf(sections);
    expect(new Set(hrefs).size).toBe(hrefs.length);
    const headingOf = (href: string) =>
      sections.find((s) => s.items.some((i) => i.href === href))?.label;
    expect(headingOf("/availability")).toBe("Mein Bereich");
    expect(headingOf("/admin/availability")).toBe("PLANUNG");
  });

  it("follows the permissions per persona and drops the availability entries with the feature", () => {
    expect(hrefsOf(visibleNavSections({ permissions: p.EMPLOYEE }, on))).toEqual([
      "/dashboard",
      "/time-entries",
      "/leave",
      "/availability",
    ]);
    const salon = hrefsOf(visibleNavSections({ permissions: p.SALON_MANAGER }, on));
    expect(salon).toContain("/admin/availability");
    expect(salon).not.toContain("/admin/phorest");
    const off = hrefsOf(
      visibleNavSections({ permissions: p.SALON_MANAGER }, { availabilityEnabled: false }),
    );
    expect(off).not.toContain("/availability");
    expect(off).not.toContain("/admin/availability");
  });
});

describe("mobile Mehr sheet renders the same sections (#516)", () => {
  beforeEach(() => {
    tenantFeatures.applyLocal(true);
  });

  for (const persona of ["ADMIN", "SALON_MANAGER", "TRAINER", "EMPLOYEE"] as const) {
    it(`${persona}: every sidebar target is a link in the sheet under its sidebar heading`, async () => {
      const user = { role: persona === "ADMIN" ? "ADMIN" : "EMPLOYEE", permissions: p[persona] };
      (authStore as unknown as { set(v: unknown): void }).set({ user });
      renderWithTheme(BottomTabBar, { currentPath: "/admin/phorest" });
      await fireEvent.click(screen.getByRole("button", { name: /^Mehr/, hidden: true }));
      const dialog = screen.getByRole("dialog", { name: "Weitere Navigation" });

      for (const section of visibleNavSections(user, on)) {
        const nav = within(dialog).getByRole("navigation", { name: section.label });
        expect(within(dialog).getByText(section.label, { selector: "h4" })).toBeInTheDocument();
        for (const item of section.items) {
          expect(
            nav.querySelector(`a[href="${item.href}"]`),
            `${persona}: ${item.href} under ${section.label}`,
          ).not.toBeNull();
        }
      }
      expect(dialog.querySelector('a[href="/admin/special-leave"]')).toBeNull();
    });
  }

  it("marks the new targets as the page (admin Verfügbarkeit and Phorest)", async () => {
    (authStore as unknown as { set(v: unknown): void }).set({
      user: { role: "ADMIN", permissions: p.ADMIN },
    });
    for (const [path, group] of [
      ["/admin/availability", "PLANUNG"],
      ["/admin/phorest", "SYSTEM"],
    ] as const) {
      const { unmount } = renderWithTheme(BottomTabBar, { currentPath: path });
      await fireEvent.click(screen.getByRole("button", { name: /^Mehr/, hidden: true }));
      const dialog = screen.getByRole("dialog", { name: "Weitere Navigation" });
      expect(dialog.querySelectorAll("[aria-current]")).toHaveLength(1);
      expect(
        within(within(dialog).getByRole("navigation", { name: group })).getByRole("link", {
          current: "page",
        }),
      ).toHaveAttribute("href", path);
      unmount();
    }
  });
});

describe("both variants are generated, not listed (#516)", () => {
  const SIDEBAR = read("../Sidebar.svelte", "src/lib/components/layout/Sidebar.svelte");
  const TAB_BAR = read("../BottomTabBar.svelte", "src/lib/components/layout/BottomTabBar.svelte");
  const SHEET = read(
    "../MobileMoreSheet.svelte",
    "src/lib/components/layout/MobileMoreSheet.svelte",
  );

  it("Sidebar and BottomTabBar render visibleNavSections()", () => {
    expect(SIDEBAR).toContain("visibleNavSections(");
    expect(TAB_BAR).toContain("visibleNavSections(");
  });

  it("no variant keeps a hand-written list of nav targets or reads the sources itself", () => {
    for (const src of [SIDEBAR, SHEET]) {
      expect(src).not.toMatch(/href:\s*"\//);
      expect(src).not.toContain("visibleTeamNavItems");
      expect(src).not.toContain("visibleAdminNav");
    }
    expect(TAB_BAR).not.toContain("visibleTeamNavItems");
    expect(TAB_BAR).not.toContain("visibleAdminNav");
  });
});

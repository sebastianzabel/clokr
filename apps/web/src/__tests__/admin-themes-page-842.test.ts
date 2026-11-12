// Issue #842 (D-842-02, D-842-16, D-842-20, D-842-22) - the Branding & Themes page: three theme
// cards, each with a light and a dark preview element that carries data-theme and data-mode so the
// real tokens render, a Modus control, no skin/density/Modern leftovers, and a subtitle that does
// not claim the choice applies to every employee.
// Issue #854 (plan 16): the page is built from a PageHead and three `.settings-group` sections (Farbwelt, Modus,
// Sprache) and promises no version; the choice is still saved through the preference stores only.
import { beforeEach, describe, expect, it, vi } from "vitest";
import { render, screen, fireEvent, cleanup } from "@testing-library/svelte";
import { get } from "svelte/store";

const { saveSpy } = vi.hoisted(() => ({
  saveSpy: vi.fn(() => Promise.resolve({})),
}));

vi.mock("$api/preferences", () => ({
  savePreferences: saveSpy,
}));

// This workspace's jsdom exposes no `localStorage` (see auth-boot-hydration.test.ts). The stores
// read it while their modules evaluate, so it is stubbed before the static imports below run.
vi.hoisted(() => {
  const map = new Map<string, string>();
  vi.stubGlobal("localStorage", {
    getItem: (k: string) => map.get(k) ?? null,
    setItem: (k: string, v: string) => void map.set(k, String(v)),
    removeItem: (k: string) => void map.delete(k),
    clear: () => map.clear(),
  });
});

import Page from "../routes/(app)/admin/themes/+page.svelte";
import { prefsHydrated } from "$stores/prefs-state";
import { theme } from "$stores/theme";
import { mode } from "$stores/mode";

beforeEach(() => {
  cleanup();
  prefsHydrated.set(false);
  mode.set("light");
  theme.set("pflaume");
  saveSpy.mockClear();
});

function cards(container: HTMLElement): HTMLButtonElement[] {
  return [...container.querySelectorAll<HTMLButtonElement>("button.theme-card")];
}

describe("#842 D-842-22 - theme cards with light and dark previews", () => {
  it("shows three cards labelled Pflaume, Salz and Petrol", () => {
    const { container } = render(Page);
    const found = cards(container);
    expect(found).toHaveLength(3);
    expect(found.map((c) => c.querySelector(".theme-label")?.textContent?.trim())).toEqual([
      "Pflaume",
      "Salz",
      "Petrol",
    ]);
  });

  it("each card holds exactly two previews: its own data-theme with data-mode light and dark", () => {
    const { container } = render(Page);
    const expected = ["pflaume", "salz", "petrol"];
    cards(container).forEach((card, i) => {
      const previews = [...card.querySelectorAll<HTMLElement>(".theme-preview")];
      expect(previews).toHaveLength(2);
      expect(previews.map((p) => p.getAttribute("data-theme"))).toEqual([expected[i], expected[i]]);
      expect(previews.map((p) => p.getAttribute("data-mode"))).toEqual(["light", "dark"]);
    });
  });

  it("previews draw with tokens only: no inline colour or background on the page", () => {
    const { container } = render(Page);
    expect(container.querySelectorAll("[style]")).toHaveLength(0);
  });

  it("marks the active theme with aria-pressed and a visible Aktiv chip", () => {
    const { container } = render(Page);
    const pressed = cards(container).map((c) => c.getAttribute("aria-pressed"));
    expect(pressed).toEqual(["true", "false", "false"]);
    expect(container.querySelectorAll(".chip-brand")).toHaveLength(1);
  });
});

describe("#854 plan 16 - the page is built from blocks", () => {
  it("has one H1 and the three settings groups Farbwelt, Modus and Sprache", () => {
    const { container } = render(Page);
    expect(screen.getByRole("heading", { level: 1 }).textContent).toBe("Branding & Themes");
    const groups = [...container.querySelectorAll("section.settings-group")];
    expect(groups.map((g) => g.querySelector("h2")?.textContent)).toEqual([
      "Farbwelt",
      "Modus",
      "Sprache",
    ]);
  });

  it("has no SaveBar (a theme or mode click saves at once) and no legacy section chrome", () => {
    const { container } = render(Page);
    expect(screen.queryByRole("region", { name: "Speicherleiste" })).toBeNull();
    expect(container.querySelector(".section-title, .section-stack")).toBeNull();
  });

  it("promises no release version for the English UI", () => {
    const { container } = render(Page);
    expect(container.textContent).toContain("Englisch folgt später.");
    expect(container.textContent).not.toMatch(/v\d+\.\d+/);
  });
});

describe("#842 D-842-02 - selecting saves instantly as a personal preference", () => {
  it("clicking Salz calls applyPreferences once with { theme: 'salz' } (one PUT)", async () => {
    prefsHydrated.set(true);
    const { container } = render(Page);
    const salz = cards(container)[1];
    await fireEvent.click(salz);

    expect(get(theme)).toBe("salz");
    expect(saveSpy).toHaveBeenCalledTimes(1);
    expect(saveSpy).toHaveBeenCalledWith({ theme: "salz" });
    expect(salz.getAttribute("aria-pressed")).toBe("true");
  });

  it("the Modus control offers Hell and Dunkel and sets the mode store", async () => {
    render(Page);
    const hell = screen.getByRole("radio", { name: "Hell" });
    const dunkel = screen.getByRole("radio", { name: "Dunkel" });
    expect(hell.getAttribute("aria-checked")).toBe("true");

    await fireEvent.click(dunkel);
    expect(get(mode)).toBe("dark");
    expect(dunkel.getAttribute("aria-checked")).toBe("true");
  });
});

describe("#842 D-842-16, D-842-20 - what is gone and what the subtitle says", () => {
  it("has no Skin, Dichte or Modern text", () => {
    const { container } = render(Page);
    const text = container.textContent ?? "";
    for (const retired of ["Skin", "Dichte", "Modern"]) {
      expect(text, retired).not.toContain(retired);
    }
  });

  it("keeps the Sprache section", () => {
    const { container } = render(Page);
    expect(container.textContent).toContain("Sprache");
  });

  it("the subtitle does not claim the choice applies to every employee", () => {
    const { container } = render(Page);
    expect(container.textContent).not.toMatch(/für alle Mitarbeitenden/);
    expect(container.textContent).toMatch(/dein Konto/);
  });
});

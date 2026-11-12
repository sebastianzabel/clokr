// Issue #851 (D-851-02) - the appearance section of the profile: Farbwelt and Modus through the same
// single-PUT path as the Branding page.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, screen } from "@testing-library/svelte";
import { renderWithTheme } from "$tests/test-utils";

const applyPreferences = vi.fn();
vi.mock("$stores/apply-preferences", () => ({
  applyPreferences: (...args: unknown[]) => applyPreferences(...args),
}));

vi.mock("$stores/theme", async () => {
  const { writable } = await import("svelte/store");
  return {
    theme: writable("pflaume"),
    themes: [
      { id: "pflaume", label: "Pflaume" },
      { id: "salz", label: "Salz" },
      { id: "petrol", label: "Petrol" },
    ],
  };
});
vi.mock("$stores/mode", async () => {
  const { writable } = await import("svelte/store");
  return { mode: writable("light") };
});

import AppearanceSettings from "../AppearanceSettings.svelte";

beforeEach(() => applyPreferences.mockClear());
afterEach(() => cleanup());

describe("AppearanceSettings", () => {
  it("offers the three themes and both modes", () => {
    renderWithTheme(AppearanceSettings, {});
    for (const label of ["Pflaume", "Salz", "Petrol", "Hell", "Dunkel"]) {
      expect(screen.getByRole("radio", { name: label })).toBeInTheDocument();
    }
  });

  it("a theme click saves the theme once", async () => {
    renderWithTheme(AppearanceSettings, {});
    await fireEvent.click(screen.getByRole("radio", { name: "Petrol" }));
    expect(applyPreferences).toHaveBeenCalledTimes(1);
    expect(applyPreferences).toHaveBeenCalledWith({ theme: "petrol" });
  });

  it("a mode click saves the mode once", async () => {
    renderWithTheme(AppearanceSettings, {});
    await fireEvent.click(screen.getByRole("radio", { name: "Dunkel" }));
    expect(applyPreferences).toHaveBeenCalledWith({ mode: "dark" });
  });
});

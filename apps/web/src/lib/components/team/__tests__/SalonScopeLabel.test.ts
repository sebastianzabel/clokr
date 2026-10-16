// Issue #558 D-04 — the mountable shared label: „Salon: <Name>“ / „Alle Salons“, nothing without
// salon options, and the calm text for a rejected salon (never an alert, never a toast).
import { describe, it, expect, vi } from "vitest";

// The label imports the shared texts from page-scope, which pulls in the api client; a stand-in
// (as in SalonTimeEntries.test.ts) keeps this file free of the auth store bootstrap.
vi.mock("$api/client", () => ({
  api: { get: vi.fn() },
  ApiError: class ApiError extends Error {},
}));
vi.mock("$lib/utils/logger", () => ({ clientLogger: { warn: vi.fn(), error: vi.fn() } }));
import { screen } from "@testing-library/svelte";
import { renderWithTheme } from "$tests/test-utils";
import SalonScopeLabel from "../SalonScopeLabel.svelte";
import { SALON_VIEW_UNAVAILABLE_TEXT } from "$lib/salons/page-scope";

describe("SalonScopeLabel", () => {
  it("renders nothing for a null label", () => {
    renderWithTheme(SalonScopeLabel, { label: null });
    expect(screen.queryByTestId("salon-scope-label")).toBeNull();
    expect(screen.queryByTestId("salon-scope-unavailable")).toBeNull();
  });

  it("renders the given label", () => {
    renderWithTheme(SalonScopeLabel, { label: "Salon: Nord" });
    expect(screen.getByTestId("salon-scope-label").textContent).toBe("Salon: Nord");
    expect(screen.queryByTestId("salon-scope-unavailable")).toBeNull();
  });

  it("renders „Alle Salons“ as given", () => {
    renderWithTheme(SalonScopeLabel, { label: "Alle Salons" });
    expect(screen.getByTestId("salon-scope-label").textContent).toBe("Alle Salons");
  });

  it("a rejected salon shows the calm text in a status region, never an alert", () => {
    renderWithTheme(SalonScopeLabel, { label: "Salon: Nord", rejected: true });
    const calm = screen.getByTestId("salon-scope-unavailable");
    expect(calm.getAttribute("role")).toBe("status");
    expect(calm.textContent).toContain(SALON_VIEW_UNAVAILABLE_TEXT);
    expect(screen.queryByRole("alert")).toBeNull();
  });

  it("the calm text is the informational variant, not the warning default (visual check 558-06)", () => {
    // The default .callout is the warn variant (orange text, 4.06:1 on its tint in light mode); a
    // rejected salon is a calm hint, so it takes the .brand variant.
    renderWithTheme(SalonScopeLabel, { label: "Salon: Nord", rejected: true });
    const calm = screen.getByTestId("salon-scope-unavailable");
    expect(calm.classList.contains("callout")).toBe(true);
    expect(calm.classList.contains("brand")).toBe(true);
    expect(calm.classList.contains("error")).toBe(false);
  });

  it("a rejected salon without a label still shows the calm text and no label line", () => {
    renderWithTheme(SalonScopeLabel, { label: null, rejected: true });
    expect(screen.queryByTestId("salon-scope-label")).toBeNull();
    expect(screen.getByTestId("salon-scope-unavailable")).toBeTruthy();
  });
});

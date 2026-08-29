// Phase 113 (GitHub issue #116) — the panel is the destination explanation the dashboard
// „Attest"-Hinweis deep-links to. These tests pin the prose (it must say WHERE the Attest goes,
// not restate that it is missing) and the structural absence of any submission control: the
// attest endpoint is requireRole("ADMIN","MANAGER") and would 403 the very person this panel
// is for.

import { describe, it, expect } from "vitest";
import { screen } from "@testing-library/svelte";
import { renderWithTheme } from "$tests/test-utils";
import KarenzAttestPanel from "../KarenzAttestPanel.svelte";

describe("KarenzAttestPanel", () => {
  it("Test 1: renders nothing at all when there is no overrun day", () => {
    renderWithTheme(KarenzAttestPanel, { label: "", days: [] });
    expect(screen.queryByTestId("karenz-attest-panel")).toBeNull();
  });

  it("Test 2: renders the count label and every affected day in German", () => {
    const { container } = renderWithTheme(KarenzAttestPanel, {
      label: "2 Tage ohne Attest",
      days: ["2026-08-10", "2026-08-11"],
    });
    expect(screen.getByTestId("karenz-attest-panel")).toBeTruthy();
    expect(container.textContent).toContain("2 Tage ohne Attest");
    expect(screen.getByTestId("karenz-attest-days").textContent).toBe("10.08.2026, 11.08.2026");
  });

  it("Test 3: the prose says WHERE the Attest goes — it does not restate the problem", () => {
    const { container } = renderWithTheme(KarenzAttestPanel, {
      label: "2 Tage ohne Attest",
      days: ["2026-08-10", "2026-08-11"],
    });
    expect(container.textContent).toContain("Clokr nimmt keine Atteste entgegen");
    expect(container.textContent).toContain("keinen Upload");
    expect(container.textContent).toContain("zum Beispiel");
    expect(container.textContent).toContain("verschwindet dieser Hinweis");
  });

  it("Test 4: the prose cites § 5 EFZG and repeats Phase 104 D-21 — the finding blocks nothing", () => {
    const { container } = renderWithTheme(KarenzAttestPanel, {
      label: "1 Tag ohne Attest",
      days: ["2026-08-10"],
    });
    expect(container.textContent).toContain("§ 5 EFZG");
    expect(container.textContent).toContain("blockiert nichts");
  });

  it("Test 5: offers no submission affordance — the endpoint requires a manager role, so an employee would get 403", () => {
    const { container } = renderWithTheme(KarenzAttestPanel, {
      label: "1 Tag ohne Attest",
      days: ["2026-08-10"],
    });
    expect(container.querySelectorAll("input, button, a")).toHaveLength(0);
    expect(container.querySelector('input[type="file"]')).toBeNull();
  });

  it("Test 6: uses the global .callout recipe rather than a private colour rule", () => {
    const { container } = renderWithTheme(KarenzAttestPanel, {
      label: "1 Tag ohne Attest",
      days: ["2026-08-10"],
    });
    const panel = container.querySelector('[data-testid="karenz-attest-panel"]');
    expect(panel?.className).toContain("callout");
  });

  it("Test 7: a single day renders without a trailing separator", () => {
    renderWithTheme(KarenzAttestPanel, {
      label: "1 Tag ohne Attest",
      days: ["2027-01-31"],
    });
    expect(screen.getByTestId("karenz-attest-days").textContent).toBe("31.01.2027");
  });
});

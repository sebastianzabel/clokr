// Phase 76-03 — ArbZGWarningBar full warning-class coverage.
//
// CLAUDE.md § ArbZG Rules enumerates every legal threshold. Each rule MUST have
// at least one assertion that the matching warning class renders correctly when
// triggered. If a future PR removes/renames a warning class, THIS test must fail.
//
// Warning classes (mapping to CLAUDE.md § ArbZG Rules):
//   - DAILY_OVER_10   : § 3 ArbZG hard daily cap (10h)
//   - WEEKLY_OVER_48  : § 3 ArbZG hard weekly cap (48h Mo-Sa)
//   - REST_UNDER_11   : § 5 ArbZG min rest period (11h)
//   - BREAK_UNDER_30  : § 4 ArbZG min break >6h work (30min)
//   - BREAK_UNDER_45  : § 4 ArbZG min break >9h work (45min)
//
// NOTE: The 8h "soft" cap is intentionally NOT a warning class here — it is a
// 24-week rolling average, not a daily limit (CLAUDE.md § ArbZG Rules).

import { describe, it, expect } from "vitest";
import { screen } from "@testing-library/svelte";
import { renderWithTheme } from "$tests/test-utils";
import ArbZGWarningBar from "../ArbZGWarningBar.svelte";

describe("ArbZGWarningBar — empty state", () => {
  it("renders nothing when warnings array is empty", () => {
    renderWithTheme(ArbZGWarningBar, { warnings: [] });
    expect(screen.queryByTestId("arbzg-warning-bar")).toBeNull();
  });
});

describe("ArbZGWarningBar — § 3 (daily/weekly max)", () => {
  it("renders DAILY_OVER_10 with §3 message and error severity", () => {
    renderWithTheme(ArbZGWarningBar, {
      warnings: [{ class: "DAILY_OVER_10", severity: "error", detailMinutes: 30 }],
    });
    const w = screen.getByTestId("arbzg-warning");
    expect(w).toHaveAttribute("data-warning-class", "DAILY_OVER_10");
    expect(w).toHaveClass("arbzg-warning--error");
    expect(w.textContent).toContain("§ 3");
    expect(w.textContent).toContain("Tagesmaximum");
  });

  it("renders WEEKLY_OVER_48 with §3 message and error severity", () => {
    renderWithTheme(ArbZGWarningBar, {
      warnings: [{ class: "WEEKLY_OVER_48", severity: "error", detailMinutes: 120 }],
    });
    const w = screen.getByTestId("arbzg-warning");
    expect(w).toHaveAttribute("data-warning-class", "WEEKLY_OVER_48");
    expect(w).toHaveClass("arbzg-warning--error");
    expect(w.textContent).toContain("Wochenmaximum");
  });
});

describe("ArbZGWarningBar — § 5 (rest period)", () => {
  it("renders REST_UNDER_11 with §5 message and warn severity", () => {
    renderWithTheme(ArbZGWarningBar, {
      warnings: [{ class: "REST_UNDER_11", severity: "warn", detailMinutes: 45 }],
    });
    const w = screen.getByTestId("arbzg-warning");
    expect(w).toHaveAttribute("data-warning-class", "REST_UNDER_11");
    expect(w).toHaveClass("arbzg-warning--warn");
    expect(w.textContent).toContain("§ 5");
    expect(w.textContent).toContain("Ruhezeit");
  });
});

describe("ArbZGWarningBar — § 4 (breaks)", () => {
  it("renders BREAK_UNDER_30 with §4 message and error severity", () => {
    renderWithTheme(ArbZGWarningBar, {
      warnings: [{ class: "BREAK_UNDER_30", severity: "error", detailMinutes: 10 }],
    });
    const w = screen.getByTestId("arbzg-warning");
    expect(w).toHaveAttribute("data-warning-class", "BREAK_UNDER_30");
    expect(w).toHaveClass("arbzg-warning--error");
    expect(w.textContent).toContain("§ 4");
    expect(w.textContent).toContain("30");
  });

  it("renders BREAK_UNDER_45 with §4 message and error severity", () => {
    renderWithTheme(ArbZGWarningBar, {
      warnings: [{ class: "BREAK_UNDER_45", severity: "error", detailMinutes: 15 }],
    });
    const w = screen.getByTestId("arbzg-warning");
    expect(w).toHaveAttribute("data-warning-class", "BREAK_UNDER_45");
    expect(w).toHaveClass("arbzg-warning--error");
    expect(w.textContent).toContain("§ 4");
    expect(w.textContent).toContain("45");
  });
});

describe("ArbZGWarningBar — detail rendering", () => {
  it('shows detail minutes for DAILY_OVER_10 ("30 Min. über Maximum")', () => {
    renderWithTheme(ArbZGWarningBar, {
      warnings: [{ class: "DAILY_OVER_10", severity: "error", detailMinutes: 30 }],
    });
    expect(screen.getByTestId("arbzg-warning-detail")).toHaveTextContent("30 Min. über Maximum");
  });

  it('shows detail minutes for BREAK_UNDER_30 ("10 Min. zu kurz")', () => {
    renderWithTheme(ArbZGWarningBar, {
      warnings: [{ class: "BREAK_UNDER_30", severity: "error", detailMinutes: 10 }],
    });
    expect(screen.getByTestId("arbzg-warning-detail")).toHaveTextContent("10 Min. zu kurz");
  });

  it("omits detail when detailMinutes is undefined", () => {
    renderWithTheme(ArbZGWarningBar, {
      warnings: [{ class: "DAILY_OVER_10", severity: "error" }],
    });
    expect(screen.queryByTestId("arbzg-warning-detail")).toBeNull();
  });
});

describe("ArbZGWarningBar — multiple warnings", () => {
  it("renders multiple warnings in input order (no implicit sort)", () => {
    renderWithTheme(ArbZGWarningBar, {
      warnings: [
        { class: "REST_UNDER_11", severity: "warn" },
        { class: "DAILY_OVER_10", severity: "error", detailMinutes: 30 },
        { class: "BREAK_UNDER_30", severity: "error", detailMinutes: 10 },
      ],
    });
    const warnings = screen.getAllByTestId("arbzg-warning");
    expect(warnings).toHaveLength(3);
    expect(warnings[0]).toHaveAttribute("data-warning-class", "REST_UNDER_11");
    expect(warnings[1]).toHaveAttribute("data-warning-class", "DAILY_OVER_10");
    expect(warnings[2]).toHaveAttribute("data-warning-class", "BREAK_UNDER_30");
  });

  it("applies .arbzg-warning--error / --warn modifier per severity", () => {
    renderWithTheme(ArbZGWarningBar, {
      warnings: [
        { class: "REST_UNDER_11", severity: "warn" },
        { class: "DAILY_OVER_10", severity: "error" },
      ],
    });
    const warnings = screen.getAllByTestId("arbzg-warning");
    expect(warnings[0]).toHaveClass("arbzg-warning--warn");
    expect(warnings[1]).toHaveClass("arbzg-warning--error");
  });
});

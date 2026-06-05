// Phase 76-03 — BSPatternPicker validation coverage.
//
// Phase 67 deliverable currently inline at admin/employees/[id]. Validation rules
// (referenced in 67-02-SUMMARY):
//   - mode switch wipes payload from inactive side (weekly → block: workDays=[],
//     block → weekly: blockYear=null) to prevent stale data being persisted
//   - workDays MUST be non-empty in weekly mode (save disabled otherwise)
//   - blockYear MUST be set in block mode (save disabled otherwise)
//
// These tests cover the pure validation logic. The richer inline editor in the
// admin page composes additional Phase 67 fields (validFrom, validUntil,
// schoolHolidays, bsBundesland, blockWeeks) — those are out of scope here.

import { describe, it, expect, vi } from "vitest";
import { fireEvent, screen } from "@testing-library/svelte";
import { renderWithTheme } from "$tests/test-utils";
import BSPatternPicker, { type BSPatternDraft } from "../BSPatternPicker.svelte";

function baseDraft(overrides: Partial<BSPatternDraft> = {}): BSPatternDraft {
  return {
    mode: "weekly",
    workDays: [1, 3], // Mo, Mi
    blockYear: null,
    ...overrides,
  };
}

describe("BSPatternPicker — initial render", () => {
  it("renders with mode=weekly by default — workDays grid visible, block fields hidden", () => {
    const onChange = vi.fn();
    renderWithTheme(BSPatternPicker, { draft: baseDraft(), onChange });
    expect(screen.getByTestId("bs-workdays-grid")).toBeInTheDocument();
    expect(screen.queryByTestId("bs-block-fields")).toBeNull();
  });

  it("renders with mode=block when draft.mode=block — block fields visible, workDays grid hidden", () => {
    const onChange = vi.fn();
    renderWithTheme(BSPatternPicker, {
      draft: baseDraft({ mode: "block", workDays: [], blockYear: 2026 }),
      onChange,
    });
    expect(screen.getByTestId("bs-block-fields")).toBeInTheDocument();
    expect(screen.queryByTestId("bs-workdays-grid")).toBeNull();
  });
});

describe("BSPatternPicker — mode switch payload guard", () => {
  it("switching from weekly to block emits onChange with workDays=[] in the patch", async () => {
    const onChange = vi.fn();
    renderWithTheme(BSPatternPicker, {
      draft: baseDraft({ mode: "weekly", workDays: [1, 3], blockYear: null }),
      onChange,
    });
    await fireEvent.click(screen.getByTestId("bs-mode-block"));
    expect(onChange).toHaveBeenCalledWith(expect.objectContaining({ mode: "block", workDays: [] }));
  });

  it("switching from block to weekly auto-clears blockYear (sets to null)", async () => {
    const onChange = vi.fn();
    renderWithTheme(BSPatternPicker, {
      draft: baseDraft({ mode: "block", workDays: [], blockYear: 2026 }),
      onChange,
    });
    await fireEvent.click(screen.getByTestId("bs-mode-weekly"));
    expect(onChange).toHaveBeenCalledWith(
      expect.objectContaining({ mode: "weekly", blockYear: null }),
    );
  });

  it("switching to the same mode does NOT emit onChange (no-op)", async () => {
    const onChange = vi.fn();
    renderWithTheme(BSPatternPicker, { draft: baseDraft({ mode: "weekly" }), onChange });
    await fireEvent.click(screen.getByTestId("bs-mode-weekly"));
    expect(onChange).not.toHaveBeenCalled();
  });
});

describe("BSPatternPicker — workDay toggling (weekly mode)", () => {
  it("toggling a workDay adds it when not present", async () => {
    const onChange = vi.fn();
    renderWithTheme(BSPatternPicker, {
      draft: baseDraft({ workDays: [1, 3] }),
      onChange,
    });
    await fireEvent.click(screen.getByTestId("bs-workday-5")); // Fr
    expect(onChange).toHaveBeenCalledWith(expect.objectContaining({ workDays: [1, 3, 5] }));
  });

  it("toggling a workDay removes it when present", async () => {
    const onChange = vi.fn();
    renderWithTheme(BSPatternPicker, {
      draft: baseDraft({ workDays: [1, 3] }),
      onChange,
    });
    await fireEvent.click(screen.getByTestId("bs-workday-1")); // Mo
    expect(onChange).toHaveBeenCalledWith(expect.objectContaining({ workDays: [3] }));
  });
});

describe("BSPatternPicker — save button validation", () => {
  it("disables save when workDays empty in weekly mode", () => {
    renderWithTheme(BSPatternPicker, {
      draft: baseDraft({ mode: "weekly", workDays: [], blockYear: null }),
      onChange: vi.fn(),
    });
    expect(screen.getByTestId("bs-save-btn")).toBeDisabled();
  });

  it("enables save when workDays non-empty in weekly mode", () => {
    renderWithTheme(BSPatternPicker, {
      draft: baseDraft({ mode: "weekly", workDays: [1] }),
      onChange: vi.fn(),
    });
    expect(screen.getByTestId("bs-save-btn")).not.toBeDisabled();
  });

  it("enables save when blockYear is set in block mode", () => {
    renderWithTheme(BSPatternPicker, {
      draft: baseDraft({ mode: "block", workDays: [], blockYear: 2026 }),
      onChange: vi.fn(),
    });
    expect(screen.getByTestId("bs-save-btn")).not.toBeDisabled();
  });

  it("disables save when blockYear missing in block mode", () => {
    renderWithTheme(BSPatternPicker, {
      draft: baseDraft({ mode: "block", workDays: [], blockYear: null }),
      onChange: vi.fn(),
    });
    expect(screen.getByTestId("bs-save-btn")).toBeDisabled();
  });
});

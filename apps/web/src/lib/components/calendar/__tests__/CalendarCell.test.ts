// Phase 76-02 — CalendarCell branch coverage (D-01).
//
// Strategy: one it() per state, plus co-occurrence + formatting edge cases.
// Per D-06, every render is wrapped in <div data-theme="pflaume"> via renderWithTheme.

import { describe, it, expect } from "vitest";
import { screen } from "@testing-library/svelte";
import { renderWithTheme } from "$tests/test-utils";
import CalendarCell from "../CalendarCell.svelte";

const D = new Date("2026-06-04T00:00:00Z");

describe("CalendarCell — regular state", () => {
  it("renders regular cell with day number", () => {
    renderWithTheme(CalendarCell, { date: D, state: "regular" });
    const cell = screen.getByTestId("calendar-cell");
    expect(cell).toHaveClass("calendar-cell");
    expect(cell).not.toHaveClass("calendar-cell--holiday");
    expect(cell.textContent).toContain("4");
  });

  it("renders +/- delta for regular cell when worked + target provided", () => {
    renderWithTheme(CalendarCell, {
      date: D,
      state: "regular",
      workedMinutes: 510,
      targetMinutes: 480,
    });
    expect(screen.getByTestId("cell-delta")).toHaveTextContent("+0:30");
  });

  it("formats positive delta with + sign and tabular zero-padding", () => {
    renderWithTheme(CalendarCell, {
      date: D,
      state: "regular",
      workedMinutes: 540,
      targetMinutes: 480,
    });
    expect(screen.getByTestId("cell-delta")).toHaveTextContent("+1:00");
  });

  it("formats negative delta with U+2212 minus sign", () => {
    renderWithTheme(CalendarCell, {
      date: D,
      state: "regular",
      workedMinutes: 450,
      targetMinutes: 480,
    });
    // Note: rendered glyph is "−" (U+2212), NOT ASCII "-"
    expect(screen.getByTestId("cell-delta")).toHaveTextContent("−0:30");
    expect(screen.getByTestId("cell-delta")).toHaveClass("calendar-cell__delta--negative");
  });

  it("omits delta on regular cell when targetMinutes missing", () => {
    renderWithTheme(CalendarCell, {
      date: D,
      state: "regular",
      workedMinutes: 510,
      // targetMinutes intentionally omitted (MONTHLY_HOURS schedule with no daily target)
    });
    expect(screen.queryByTestId("cell-delta")).toBeNull();
  });
});

describe("CalendarCell — holiday state", () => {
  it("renders holiday cell with .calendar-cell--holiday class", () => {
    renderWithTheme(CalendarCell, {
      date: D,
      state: "holiday",
      holidayName: "Pfingstmontag",
    });
    expect(screen.getByTestId("calendar-cell")).toHaveClass("calendar-cell--holiday");
  });

  it("shows holidayName text for holiday state", () => {
    renderWithTheme(CalendarCell, {
      date: D,
      state: "holiday",
      holidayName: "Pfingstmontag",
    });
    expect(screen.getByTestId("cell-holiday-name")).toHaveTextContent("Pfingstmontag");
  });
});

describe("CalendarCell — absence state", () => {
  it("renders absence cell with .calendar-cell--absence class", () => {
    renderWithTheme(CalendarCell, {
      date: D,
      state: "absence",
      absenceLabel: "Krankheit",
    });
    expect(screen.getByTestId("calendar-cell")).toHaveClass("calendar-cell--absence");
  });

  it("shows absenceLabel text for absence state", () => {
    renderWithTheme(CalendarCell, {
      date: D,
      state: "absence",
      absenceLabel: "Krankheit",
    });
    expect(screen.getByTestId("cell-absence-label")).toHaveTextContent("Krankheit");
  });
});

describe("CalendarCell — locked state", () => {
  it("renders locked cell with .calendar-cell--locked class + lock badge", () => {
    renderWithTheme(CalendarCell, { date: D, state: "locked" });
    expect(screen.getByTestId("calendar-cell")).toHaveClass("calendar-cell--locked");
    expect(screen.getByTestId("cell-lock-badge")).toBeInTheDocument();
  });
});

describe("CalendarCell — shift-overlap state", () => {
  it("renders shift-overlap cell with .calendar-cell--overlap class + start/end times", () => {
    renderWithTheme(CalendarCell, {
      date: D,
      state: "shift-overlap",
      overlapWith: { startHHmm: "09:00", endHHmm: "17:00" },
    });
    expect(screen.getByTestId("calendar-cell")).toHaveClass("calendar-cell--overlap");
    expect(screen.getByTestId("cell-overlap-times")).toHaveTextContent("09:00–17:00");
  });
});

describe("CalendarCell — isLocked co-occurrence (D-01 branch)", () => {
  it("shows lock badge when isLocked=true even on regular state (co-occurrence)", () => {
    renderWithTheme(CalendarCell, {
      date: D,
      state: "regular",
      isLocked: true,
      workedMinutes: 480,
      targetMinutes: 480,
    });
    expect(screen.getByTestId("cell-lock-badge")).toBeInTheDocument();
  });

  it("keeps primary state class when isLocked co-occurs (no class replacement)", () => {
    renderWithTheme(CalendarCell, {
      date: D,
      state: "holiday",
      holidayName: "Pfingstmontag",
      isLocked: true,
    });
    const cell = screen.getByTestId("calendar-cell");
    expect(cell).toHaveClass("calendar-cell--holiday"); // primary preserved
    expect(cell).toHaveClass("calendar-cell--locked"); // modifier added
  });
});

describe("CalendarCell — metadata", () => {
  it("exposes data-date attribute matching the ISO date", () => {
    renderWithTheme(CalendarCell, { date: D, state: "regular" });
    expect(screen.getByTestId("calendar-cell")).toHaveAttribute("data-date", "2026-06-04");
  });
});

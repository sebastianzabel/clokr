// Quick task 260820-elk — MonatSaldoCard state coverage. This suite is how the six
// required states (per 260820-elk-PLAN.md must_haves) get PROVEN — the docker fixture only
// exercises the negative-saldo case by hand. Every render wrapped in data-theme
// (renderWithTheme, D-06 house pattern).

import { describe, it, expect, vi } from "vitest";
import { screen } from "@testing-library/svelte";
import { fireEvent } from "@testing-library/svelte";
import { renderWithTheme } from "$tests/test-utils";
import MonatSaldoCard from "../MonatSaldoCard.svelte";

function baseProps(overrides: Record<string, unknown> = {}) {
  return {
    sollToDateMin: 0,
    istMin: 0,
    saldoMin: 0 as number | null,
    sollLabel: "Soll (bisher)",
    workdaysSoFar: 0 as number | null,
    runningCount: 0,
    isLocked: false,
    ...overrides,
  };
}

describe("MonatSaldoCard — month start, no booking", () => {
  it("renders the no-Soll branch, figure ±0:00, and does not crash", () => {
    renderWithTheme(MonatSaldoCard, baseProps());
    expect(screen.getByTestId("soll-ist-bar-nosoll")).toBeInTheDocument();
    expect(screen.queryByTestId("soll-ist-bar")).not.toBeInTheDocument();
    expect(screen.getByTestId("monat-saldo-figure")).toHaveTextContent("0:00");
  });
});

describe("MonatSaldoCard — negative saldo", () => {
  it('shows "−8:00" with the negative tone and "fehlen 8:00 h"', () => {
    renderWithTheme(
      MonatSaldoCard,
      baseProps({ sollToDateMin: 3360, istMin: 2880, saldoMin: -480 }),
    );
    const figure = screen.getByTestId("monat-saldo-figure");
    expect(figure).toHaveTextContent("−8:00");
    expect(figure).toHaveClass("msc-figure--bad");
    expect(screen.getByText("fehlen 8:00 h")).toBeInTheDocument();
  });
});

describe("MonatSaldoCard — positive saldo", () => {
  it('shows "+8:00" and "+8:00 h mehr"', () => {
    renderWithTheme(
      MonatSaldoCard,
      baseProps({ sollToDateMin: 2880, istMin: 3360, saldoMin: 480 }),
    );
    const figure = screen.getByTestId("monat-saldo-figure");
    expect(figure).toHaveTextContent("+8:00");
    expect(figure).toHaveClass("msc-figure--good");
    expect(screen.getByText("+8:00 h mehr")).toBeInTheDocument();
  });
});

describe("MonatSaldoCard — saldo exactly 0", () => {
  it('shows "±0:00" with a neutral tone', () => {
    renderWithTheme(MonatSaldoCard, baseProps({ sollToDateMin: 2880, istMin: 2880, saldoMin: 0 }));
    const figure = screen.getByTestId("monat-saldo-figure");
    expect(figure).toHaveTextContent("0:00");
    expect(figure.textContent).toContain("±");
    expect(figure).toHaveClass("msc-figure--neutral");
  });
});

describe("MonatSaldoCard — open month", () => {
  it("status line is informative-only: no close affordance, no interactive element", () => {
    const { container } = renderWithTheme(MonatSaldoCard, baseProps({ isLocked: false }));
    expect(screen.getByText(/Noch kein Monatsabschluss/)).toBeInTheDocument();
    expect(screen.getByText("Abschluss durch die Betriebsleitung")).toBeInTheDocument();
    expect(container.querySelector("button")).toBeNull();
    expect(container.querySelector("a")).toBeNull();
  });

  it("canCloseMonth defaults to false when the prop is omitted (close text still shows)", () => {
    renderWithTheme(MonatSaldoCard, baseProps());
    expect(screen.getByText("Abschluss durch die Betriebsleitung")).toBeInTheDocument();
  });
});

describe("MonatSaldoCard — closed month", () => {
  it('status line says "abgeschlossen" + "final"; microlabel reads "Bestätigt"', () => {
    renderWithTheme(MonatSaldoCard, baseProps({ isLocked: true }));
    expect(screen.getByText(/abgeschlossen/)).toBeInTheDocument();
    expect(screen.getByText(/final/)).toBeInTheDocument();
    expect(screen.getByText("Monat-Saldo (Bestätigt)")).toBeInTheDocument();
    expect(screen.queryByText(/Prognose/)).not.toBeInTheDocument();
  });
});

describe("MonatSaldoCard — canCloseMonth true", () => {
  it('hides "Abschluss durch die Betriebsleitung" but still renders no button', () => {
    const { container } = renderWithTheme(
      MonatSaldoCard,
      baseProps({ isLocked: false, canCloseMonth: true }),
    );
    expect(screen.queryByText("Abschluss durch die Betriebsleitung")).not.toBeInTheDocument();
    expect(container.querySelector("button")).toBeNull();
  });
});

describe("MonatSaldoCard — loading", () => {
  it("renders skeletons, no figure text, no spinner; the root card element is present", () => {
    const { container } = renderWithTheme(MonatSaldoCard, baseProps({ loading: true }));
    expect(screen.getByTestId("monat-saldo-card")).toBeInTheDocument();
    expect(screen.queryByTestId("monat-saldo-figure")).not.toBeInTheDocument();
    expect(container.querySelectorAll(".skeleton").length).toBeGreaterThan(0);
    expect(container.querySelector(".spinner")).toBeNull();
  });
});

describe("MonatSaldoCard — error", () => {
  it('renders "Erneut laden" and calls onRetry exactly once on click', async () => {
    const onRetry = vi.fn();
    renderWithTheme(MonatSaldoCard, baseProps({ error: true, onRetry }));
    const btn = screen.getByRole("button", { name: "Erneut laden" });
    await fireEvent.click(btn);
    expect(onRetry).toHaveBeenCalledTimes(1);
  });
});

describe("MonatSaldoCard — Arbeitstage-Zähler (Phase 125, issue #125)", () => {
  it("present: shows the day count when workdaysSoFar is a number", () => {
    renderWithTheme(MonatSaldoCard, baseProps({ workdaysSoFar: 8 }));
    const el = screen.getByTestId("monat-saldo-workdays");
    expect(el).toHaveTextContent("8 Arbeitstage bisher");
  });

  it("absent: shows no day count when workdaysSoFar is null, figure still renders", () => {
    renderWithTheme(MonatSaldoCard, baseProps({ workdaysSoFar: null }));
    expect(screen.queryByTestId("monat-saldo-workdays")).not.toBeInTheDocument();
    expect(screen.queryByText(/Arbeitstage bisher/)).not.toBeInTheDocument();
    expect(screen.getByTestId("monat-saldo-figure")).toBeInTheDocument();
  });

  it("absent but running: the running counter survives even without a day count", () => {
    renderWithTheme(MonatSaldoCard, baseProps({ workdaysSoFar: null, runningCount: 1 }));
    expect(screen.queryByText(/Arbeitstage bisher/)).not.toBeInTheDocument();
    expect(screen.getByText(/1 läuft/)).toBeInTheDocument();
  });

  it("present with running: both the day count and the running counter show in one line", () => {
    renderWithTheme(MonatSaldoCard, baseProps({ workdaysSoFar: 3, runningCount: 2 }));
    const el = screen.getByTestId("monat-saldo-workdays");
    expect(el).toHaveTextContent("3 Arbeitstage bisher");
    expect(el).toHaveTextContent("2 läuft");
  });
});

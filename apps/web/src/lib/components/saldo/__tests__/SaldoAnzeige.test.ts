// Phase 76-02 — SaldoAnzeige state coverage.
//
// 5 visual states × isLocked × variant matrix. Per D-06, every render wrapped in data-theme.

import { describe, it, expect } from "vitest";
import { screen } from "@testing-library/svelte";
import { renderWithTheme } from "$tests/test-utils";
import SaldoAnzeige from "../SaldoAnzeige.svelte";

describe("SaldoAnzeige — sign states", () => {
  it('renders 0h saldo as "0:00" with .saldo--zero class', () => {
    renderWithTheme(SaldoAnzeige, { saldoMinutes: 0 });
    const root = screen.getByTestId("saldo-anzeige");
    expect(root).toHaveClass("saldo--zero");
    expect(screen.getByTestId("saldo-value")).toHaveTextContent("0:00");
  });

  it("renders positive saldo with + sign and .saldo--positive class", () => {
    renderWithTheme(SaldoAnzeige, { saldoMinutes: 120 });
    expect(screen.getByTestId("saldo-anzeige")).toHaveClass("saldo--positive");
    expect(screen.getByTestId("saldo-value")).toHaveTextContent("+2:00");
  });

  it("renders negative saldo with U+2212 minus and .saldo--negative class", () => {
    renderWithTheme(SaldoAnzeige, { saldoMinutes: -90 });
    expect(screen.getByTestId("saldo-anzeige")).toHaveClass("saldo--negative");
    expect(screen.getByTestId("saldo-value")).toHaveTextContent("−1:30");
  });

  it('renders null saldo as "Kein Stundenplan" with .saldo--no-schedule class', () => {
    renderWithTheme(SaldoAnzeige, { saldoMinutes: null });
    expect(screen.getByTestId("saldo-anzeige")).toHaveClass("saldo--no-schedule");
    expect(screen.getByTestId("saldo-value")).toHaveTextContent("Kein Stundenplan");
  });
});

describe("SaldoAnzeige — locked state", () => {
  it("adds .saldo--locked class when isLocked=true", () => {
    renderWithTheme(SaldoAnzeige, { saldoMinutes: 60, isLocked: true });
    expect(screen.getByTestId("saldo-anzeige")).toHaveClass("saldo--locked");
  });

  it("keeps sign class when isLocked co-occurs (no replacement)", () => {
    renderWithTheme(SaldoAnzeige, { saldoMinutes: -30, isLocked: true });
    const root = screen.getByTestId("saldo-anzeige");
    expect(root).toHaveClass("saldo--negative"); // sign preserved
    expect(root).toHaveClass("saldo--locked"); // modifier added
  });

  it("renders lock badge with aria-label when isLocked=true", () => {
    renderWithTheme(SaldoAnzeige, { saldoMinutes: 0, isLocked: true });
    const badge = screen.getByTestId("saldo-locked-badge");
    expect(badge).toBeInTheDocument();
    expect(badge).toHaveAttribute("aria-label", "Monat abgeschlossen");
  });
});

describe("SaldoAnzeige — variant", () => {
  it("hides label when variant=compact", () => {
    renderWithTheme(SaldoAnzeige, { saldoMinutes: 60, variant: "compact" });
    expect(screen.queryByTestId("saldo-label")).toBeNull();
    expect(screen.getByTestId("saldo-anzeige")).toHaveClass("saldo--compact");
  });

  it("shows label when variant=expanded (default)", () => {
    renderWithTheme(SaldoAnzeige, { saldoMinutes: 60 });
    expect(screen.getByTestId("saldo-label")).toHaveTextContent("Saldo");
  });

  it("renders custom label when label prop provided", () => {
    renderWithTheme(SaldoAnzeige, { saldoMinutes: 60, label: "Übertrag" });
    expect(screen.getByTestId("saldo-label")).toHaveTextContent("Übertrag");
  });
});

describe("SaldoAnzeige — formatting", () => {
  it("zero-pads minute portion (e.g., +1:05 not +1:5)", () => {
    renderWithTheme(SaldoAnzeige, { saldoMinutes: 65 });
    expect(screen.getByTestId("saldo-value")).toHaveTextContent("+1:05");
  });
});

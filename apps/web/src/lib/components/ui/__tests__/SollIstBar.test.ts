// Quick task 260820-elk — SollIstBar state coverage. Every render wrapped in
// data-theme (renderWithTheme, per D-06 house pattern). Geometry math + zero-division
// guards are the highest-risk part of this component — see behaviour spec in
// 260820-elk-PLAN.md Task 1.

import { describe, it, expect } from "vitest";
import { screen } from "@testing-library/svelte";
import { renderWithTheme } from "$tests/test-utils";
import SollIstBar from "../SollIstBar.svelte";

describe("SollIstBar — behind (negative saldo)", () => {
  it("renders the base segment + deficit, no overhang, and the 'fehlen' mid label", () => {
    renderWithTheme(SollIstBar, { sollToDateMin: 3360, istMin: 2880 });
    const track = screen.getByTestId("soll-ist-bar");
    expect(track).toBeInTheDocument();
    expect(track).toHaveAttribute("role", "img");
    expect(screen.getByText("fehlen 8:00 h")).toBeInTheDocument();
  });

  it("aria-label names both figures and the deficit", () => {
    renderWithTheme(SollIstBar, { sollToDateMin: 3360, istMin: 2880 });
    const track = screen.getByTestId("soll-ist-bar");
    const label = track.getAttribute("aria-label") ?? "";
    expect(label).toContain("48:00 von 56:00 Stunden erfüllt");
    expect(label).toContain("8:00 Stunden fehlen");
  });

  it("shows Ist and Soll also as visible text (never colour-only)", () => {
    renderWithTheme(SollIstBar, { sollToDateMin: 3360, istMin: 2880 });
    expect(screen.getByText("Ist 48:00 h")).toBeInTheDocument();
    expect(screen.getByText("Soll 56:00 h")).toBeInTheDocument();
  });
});

describe("SollIstBar — ahead (positive saldo)", () => {
  it("renders the overhang segment, no deficit, and the '+…mehr' mid label", () => {
    renderWithTheme(SollIstBar, { sollToDateMin: 2880, istMin: 3360 });
    expect(screen.getByTestId("soll-ist-bar")).toBeInTheDocument();
    expect(screen.getByText("+8:00 h mehr")).toBeInTheDocument();
  });

  it("aria-label reports the overhang as 'mehr'", () => {
    renderWithTheme(SollIstBar, { sollToDateMin: 2880, istMin: 3360 });
    const label = screen.getByTestId("soll-ist-bar").getAttribute("aria-label") ?? "";
    expect(label).toContain("56:00 von 48:00 Stunden erfüllt");
    expect(label).toContain("8:00 Stunden mehr");
  });
});

describe("SollIstBar — exactly equal", () => {
  it("renders 100% base, no deficit/overhang, and 'ausgeglichen'", () => {
    renderWithTheme(SollIstBar, { sollToDateMin: 2880, istMin: 2880 });
    expect(screen.getByTestId("soll-ist-bar")).toBeInTheDocument();
    expect(screen.getByText("ausgeglichen")).toBeInTheDocument();
  });
});

describe("SollIstBar — no Soll (division-by-zero guard)", () => {
  it("soll 0 / ist 0 renders NO track element, just the no-Soll text", () => {
    renderWithTheme(SollIstBar, { sollToDateMin: 0, istMin: 0 });
    expect(screen.queryByTestId("soll-ist-bar")).not.toBeInTheDocument();
    const text = screen.getByTestId("soll-ist-bar-nosoll");
    expect(text).toHaveTextContent("noch keine Sollzeit in diesem Monat");
    expect(document.body.textContent).not.toContain("NaN");
    expect(document.body.textContent).not.toContain("Infinity");
  });

  it("soll 0 / ist 240 (booked time, no Soll) stays on the no-track branch", () => {
    renderWithTheme(SollIstBar, { sollToDateMin: 0, istMin: 240 });
    expect(screen.queryByTestId("soll-ist-bar")).not.toBeInTheDocument();
    expect(screen.getByTestId("soll-ist-bar-nosoll")).toBeInTheDocument();
    expect(document.body.textContent).not.toContain("NaN");
    expect(document.body.textContent).not.toContain("Infinity");
  });
});

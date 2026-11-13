// Issue #599 (Phase 851) - a day is read first: no input field, the figures and entries, the closed
// month explained before anything is filled in, and the status of a correction request (API #902).
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, screen } from "@testing-library/svelte";
import { renderWithTheme } from "$tests/test-utils";
import DaySheet from "../DaySheet.svelte";

afterEach(() => cleanup());

const base = {
  open: true,
  title: "Freitag, 6. November",
  sollMin: 480,
  istMin: 595,
  entries: [{ id: "a", from: "09:30", to: "20:10", pause: "0:45", net: "9:55 h" }],
  locked: false,
  future: false,
  primaryLabel: "Bearbeiten",
  onPrimary: () => {},
};

describe("DaySheet", () => {
  it("shows Soll, Ist, Differenz and the entries without any input field", () => {
    renderWithTheme(DaySheet, base);
    const sheet = screen.getByTestId("day-sheet");
    expect(sheet.textContent).toContain("8:00 h");
    expect(sheet.textContent).toContain("9:55 h");
    expect(sheet.textContent).toContain("+1:55");
    expect(document.querySelectorAll("input, select, textarea")).toHaveLength(0);
  });

  it("runs the page's action from its primary button", async () => {
    const onPrimary = vi.fn();
    renderWithTheme(DaySheet, { ...base, onPrimary });
    await fireEvent.click(screen.getByTestId("day-sheet-primary"));
    expect(onPrimary).toHaveBeenCalledTimes(1);
  });

  it("explains a closed month before anything is filled in and offers the request", async () => {
    const onPrimary = vi.fn();
    renderWithTheme(DaySheet, {
      ...base,
      locked: true,
      primaryLabel: "Korrektur anfragen",
      onPrimary,
    });
    expect(screen.getByTestId("day-sheet").textContent).toContain("Dieser Monat ist abgeschlossen");
    await fireEvent.click(screen.getByTestId("day-sheet-primary"));
    expect(onPrimary).toHaveBeenCalledTimes(1);
  });

  it("shows a request's status with the review note instead of the lock note", () => {
    renderWithTheme(DaySheet, {
      ...base,
      locked: true,
      primaryLabel: null,
      requestStatus: { label: "Korrektur abgelehnt", tone: "bad", note: "Bitte Beleg nachreichen" },
    });
    const status = screen.getByTestId("day-sheet-request-status");
    expect(status.textContent).toContain("Korrektur abgelehnt");
    expect(status.textContent).toContain("Bitte Beleg nachreichen");
    expect(screen.getByTestId("day-sheet").textContent).not.toContain(
      "Dieser Monat ist abgeschlossen",
    );
  });

  it("a future day shows no figures and no action", () => {
    renderWithTheme(DaySheet, { ...base, future: true, entries: [], primaryLabel: null });
    expect(screen.getByTestId("day-sheet").textContent).toContain("liegt in der Zukunft");
    expect(screen.queryByTestId("day-sheet-primary")).toBeNull();
  });
});

// Issue #853 (additive, Team › Zeiten): the manager's sheet carries the entry details the list no
// longer shows, the day's findings and a closed-month text addressed to the manager.
describe("DaySheet - manager additions (#853)", () => {
  it("shows source, note and findings, and the manager's closed-month text", async () => {
    const { createRawSnippet } = await import("svelte");
    const entryActions = createRawSnippet((e: () => { id: string }) => ({
      render: () => `<button type="button">Bearbeiten ${e().id}</button>`,
    }));
    renderWithTheme(DaySheet, {
      ...base,
      locked: true,
      lockedText: "Der Monat ist abgeschlossen.",
      findings: ["Pause zu kurz"],
      entries: [{ ...base.entries[0], source: "Mobil", note: "Kasse", testId: "row-a" }],
      entryActions,
    });
    const sheet = screen.getByTestId("day-sheet");
    expect(screen.getByTestId("row-a").textContent).toContain("Mobil");
    expect(screen.getByTestId("row-a").textContent).toContain("Kasse");
    expect(screen.getByRole("button", { name: "Bearbeiten a" })).toBeTruthy();
    expect(sheet.textContent).toContain("Pause zu kurz");
    expect(sheet.textContent).toContain("Der Monat ist abgeschlossen.");
    expect(sheet.textContent).not.toContain("deine Leitung");
  });

  it("without the additions it renders exactly the person's sheet", () => {
    renderWithTheme(DaySheet, base);
    const header = [...document.querySelectorAll("th")].map((th) => th.textContent);
    expect(header).toEqual(["Von", "Bis", "Pause", "Netto"]);
  });
});

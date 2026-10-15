// Issue #563 (D-05) - the week editor, mounted. `lint:ui-classes` does not scan
// lib/components/admin, so this test is the component's gate: seven German rows, the closed
// checkbox disables that row's times, the bound `days` follows every edit, `disabled` locks
// everything, errors sit next to their row and are tied to the inputs, every control has a name.
import { describe, expect, it } from "vitest";
import { fireEvent, screen } from "@testing-library/svelte";
import { tick } from "svelte";

import { renderWithTheme } from "$tests/test-utils";
import OpeningHoursEditorHarness from "$tests/fixtures/OpeningHoursEditorHarness.svelte";
import { WEEKDAY_LABELS, type OpeningHoursDay } from "$lib/salons/opening-hours";

const WEEK: OpeningHoursDay[] = WEEKDAY_LABELS.map((_, day) => ({
  day,
  open: "09:00",
  close: "18:00",
  closed: false,
}));

const bound = (): OpeningHoursDay[] =>
  JSON.parse(screen.getByTestId("bound-days").textContent ?? "[]");

describe("OpeningHoursEditor", () => {
  it("renders seven rows labelled Montag to Sonntag", () => {
    renderWithTheme(OpeningHoursEditorHarness, { initial: WEEK });
    expect(WEEKDAY_LABELS).toHaveLength(7);
    for (const label of WEEKDAY_LABELS) {
      expect(screen.getByText(label, { selector: ".ohe-day" })).toBeInTheDocument();
    }
    expect(document.querySelectorAll(".ohe-row:not(.ohe-row--head)")).toHaveLength(7);
  });

  it("gives every checkbox and time input an accessible name that contains the weekday", () => {
    renderWithTheme(OpeningHoursEditorHarness, { initial: WEEK });
    for (const label of WEEKDAY_LABELS) {
      expect(screen.getByRole("checkbox", { name: `Geschlossen ${label}` })).toBeInTheDocument();
      expect(screen.getByLabelText(`Öffnung ${label}`)).toBeInTheDocument();
      expect(screen.getByLabelText(`Schließung ${label}`)).toBeInTheDocument();
    }
    for (const input of document.querySelectorAll<HTMLInputElement>("input")) {
      const names = Array.from(input.labels ?? []).map((l) => l.textContent ?? "");
      expect(
        names.some((name) => WEEKDAY_LABELS.some((day) => name.includes(day))),
        input.id,
      ).toBe(true);
    }
  });

  it("ticking Geschlossen disables that row's two time inputs and updates the bound days", async () => {
    renderWithTheme(OpeningHoursEditorHarness, { initial: WEEK });
    const open = screen.getByLabelText("Öffnung Mittwoch") as HTMLInputElement;
    const close = screen.getByLabelText("Schließung Mittwoch") as HTMLInputElement;
    expect(open.disabled).toBe(false);

    await fireEvent.click(screen.getByRole("checkbox", { name: "Geschlossen Mittwoch" }));
    await tick();

    expect(open.disabled).toBe(true);
    expect(close.disabled).toBe(true);
    expect(bound()[2].closed).toBe(true);
    // Only that row changed; the neighbours keep their times.
    expect((screen.getByLabelText("Öffnung Dienstag") as HTMLInputElement).disabled).toBe(false);
    expect(bound()[1].closed).toBe(false);
  });

  it("changing an Öffnung or Schließung value updates the bound days", async () => {
    renderWithTheme(OpeningHoursEditorHarness, { initial: WEEK });
    await fireEvent.change(screen.getByLabelText("Öffnung Montag"), { target: { value: "07:30" } });
    await fireEvent.change(screen.getByLabelText("Schließung Montag"), {
      target: { value: "16:45" },
    });
    await tick();
    expect(bound()[0]).toMatchObject({ day: 0, open: "07:30", close: "16:45" });
    expect(bound()[1]).toMatchObject({ day: 1, open: "09:00", close: "18:00" });
  });

  it("disabled disables every control", () => {
    renderWithTheme(OpeningHoursEditorHarness, { initial: WEEK, disabled: true });
    const inputs = document.querySelectorAll<HTMLInputElement>("input");
    expect(inputs).toHaveLength(21);
    for (const input of inputs) expect(input.disabled, input.id).toBe(true);
  });

  it("shows an error next to its row and ties that row's inputs to it with aria-describedby", () => {
    renderWithTheme(OpeningHoursEditorHarness, {
      initial: WEEK,
      errors: { 3: "Die Öffnung muss vor der Schließung liegen." },
    });
    const message = screen.getByText("Die Öffnung muss vor der Schließung liegen.");
    expect(message.id).toBeTruthy();
    const row = message.closest(".ohe-row");
    expect(row).not.toBeNull();
    expect(row?.textContent).toContain("Donnerstag");
    for (const name of ["Öffnung Donnerstag", "Schließung Donnerstag"]) {
      const input = screen.getByLabelText(name);
      expect(input.getAttribute("aria-describedby")).toBe(message.id);
      expect(input.getAttribute("aria-invalid")).toBe("true");
    }
    // A row without an error carries no reference.
    expect(screen.getByLabelText("Öffnung Montag").getAttribute("aria-describedby")).toBeNull();
  });
});

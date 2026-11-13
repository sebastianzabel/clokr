// Issue #854 (plan 854-26) - the Monatsabschluss stepper: four labelled steps, exactly the active one
// carries aria-current="step", finished steps are announced as done and nothing before/after is current.
import { describe, expect, it } from "vitest";
import { screen, within } from "@testing-library/svelte";

import { renderWithTheme } from "$tests/test-utils";
import CloseStepper from "../CloseStepper.svelte";

const STEPS = ["Prüfen", "Korrigieren", "Bestätigen", "Sperren"];

describe("CloseStepper", () => {
  it("lists the four steps in order inside a named navigation", () => {
    renderWithTheme(CloseStepper, { steps: STEPS, current: 0 });
    const nav = screen.getByRole("navigation", { name: "Schritte des Monatsabschlusses" });
    const items = within(nav).getAllByRole("listitem");
    expect(items.map((li) => li.textContent?.replace(/\s+/g, " ").trim())).toEqual([
      "1 Prüfen",
      "2 Korrigieren",
      "3 Bestätigen",
      "4 Sperren",
    ]);
  });

  it("marks only the active step with aria-current=step", () => {
    renderWithTheme(CloseStepper, { steps: STEPS, current: 2 });
    const current = document.querySelectorAll('[aria-current="step"]');
    expect(current).toHaveLength(1);
    expect(current[0].textContent).toContain("Bestätigen");
  });

  it("announces the finished steps and shows a check instead of the number", () => {
    renderWithTheme(CloseStepper, { steps: STEPS, current: 2 });
    expect(screen.getAllByText("(erledigt)")).toHaveLength(2);
    expect(screen.getByTestId("close-step-0").textContent).not.toMatch(/1/);
    expect(screen.getByTestId("close-step-3").textContent).toContain("4");
  });

  it("has no current step when the index is past the last step (all done)", () => {
    renderWithTheme(CloseStepper, { steps: STEPS, current: 4 });
    expect(document.querySelectorAll('[aria-current="step"]')).toHaveLength(0);
    expect(screen.getAllByText("(erledigt)")).toHaveLength(4);
  });
});

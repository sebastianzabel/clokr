// Issue #494 R5 / D-05 / D-13 — the "Überstunden-Modus" select is locked to "Nur erfassen"
// (display only) while a MONTHLY_HOURS contract has no monthly hours. The lock must never
// call onchange, because the page would then overwrite a stored mode through the form.

import { describe, it, expect, vi } from "vitest";
import { screen, fireEvent } from "@testing-library/svelte";
import { renderWithTheme } from "$tests/test-utils";
import OvertimeModeField from "../OvertimeModeField.svelte";

const HINT = "Ohne Monatsstunden werden Stunden nur erfasst, nicht übertragen.";

function select(): HTMLSelectElement {
  return screen.getByLabelText("Überstunden-Modus") as HTMLSelectElement;
}

describe("OvertimeModeField — locked without monthly hours", () => {
  it("monthlyHours 0: disabled, shows TRACK_ONLY, hint visible, onchange never called", () => {
    const onchange = vi.fn();
    renderWithTheme(OvertimeModeField, {
      type: "MONTHLY_HOURS",
      monthlyHours: 0,
      value: "CARRY_FORWARD",
      onchange,
    });
    expect(select()).toBeDisabled();
    expect(select().value).toBe("TRACK_ONLY");
    expect(screen.getByText(HINT)).toBeInTheDocument();
    expect(onchange).not.toHaveBeenCalled();
  });

  it("a change event on the locked select never reaches onchange (WR-04)", async () => {
    const onchange = vi.fn();
    renderWithTheme(OvertimeModeField, {
      type: "MONTHLY_HOURS",
      monthlyHours: 0,
      value: "CARRY_FORWARD",
      onchange,
    });
    await fireEvent.change(select(), { target: { value: "CARRY_FORWARD" } });
    expect(onchange).not.toHaveBeenCalled();
  });

  it("the hint is associated with the locked select via aria-describedby (WR-03)", () => {
    renderWithTheme(OvertimeModeField, {
      type: "MONTHLY_HOURS",
      monthlyHours: 0,
      value: "CARRY_FORWARD",
      onchange: vi.fn(),
    });
    const hint = screen.getByText(HINT);
    expect(hint.id).toBe("e-overtime-mode-hint");
    expect(select().getAttribute("aria-describedby")).toBe(hint.id);
    expect(select().id).toBe("e-overtime-mode");
  });

  it("a custom id moves both the select id and the hint id (WR-03)", () => {
    renderWithTheme(OvertimeModeField, {
      type: "MONTHLY_HOURS",
      monthlyHours: 0,
      value: "CARRY_FORWARD",
      onchange: vi.fn(),
      id: "other-mode",
    });
    expect(select().id).toBe("other-mode");
    expect(select().getAttribute("aria-describedby")).toBe("other-mode-hint");
    expect(screen.getByText(HINT).id).toBe("other-mode-hint");
  });

  it("monthlyHours null (cleared number input): locked as well", () => {
    const onchange = vi.fn();
    renderWithTheme(OvertimeModeField, {
      type: "MONTHLY_HOURS",
      monthlyHours: null,
      value: "CARRY_FORWARD",
      onchange,
    });
    expect(select()).toBeDisabled();
    expect(select().value).toBe("TRACK_ONLY");
    expect(screen.getByText(HINT)).toBeInTheDocument();
    expect(onchange).not.toHaveBeenCalled();
  });
});

describe("OvertimeModeField — locking is display only (WR-04)", () => {
  it("re-render 15 -> 0 -> 15 keeps the stored CARRY_FORWARD and never calls onchange", async () => {
    const onchange = vi.fn();
    const props = {
      type: "MONTHLY_HOURS",
      monthlyHours: 15 as number | null,
      value: "CARRY_FORWARD" as const,
      onchange,
    };
    const { rerender } = renderWithTheme(OvertimeModeField, props);
    expect(select().value).toBe("CARRY_FORWARD");

    await rerender({ ...props, monthlyHours: 0 });
    expect(select()).toBeDisabled();
    expect(select().value).toBe("TRACK_ONLY");

    await rerender({ ...props, monthlyHours: 15 });
    expect(select()).not.toBeDisabled();
    expect(select().value).toBe("CARRY_FORWARD");
    expect(screen.queryByText(HINT)).not.toBeInTheDocument();
    expect(select().hasAttribute("aria-describedby")).toBe(false);
    expect(onchange).not.toHaveBeenCalled();
  });
});

describe("OvertimeModeField — unlocked with monthly hours", () => {
  it("monthlyHours 15, stored CARRY_FORWARD: enabled, shows it, no hint, change is forwarded once", async () => {
    const onchange = vi.fn();
    renderWithTheme(OvertimeModeField, {
      type: "MONTHLY_HOURS",
      monthlyHours: 15,
      value: "CARRY_FORWARD",
      onchange,
    });
    expect(select()).not.toBeDisabled();
    expect(select().value).toBe("CARRY_FORWARD");
    expect(screen.queryByText(HINT)).not.toBeInTheDocument();
    await fireEvent.change(select(), { target: { value: "TRACK_ONLY" } });
    expect(onchange).toHaveBeenCalledTimes(1);
    expect(onchange).toHaveBeenCalledWith("TRACK_ONLY");
  });

  it("monthlyHours 15, stored TRACK_ONLY: enabled, shows TRACK_ONLY, no hint", () => {
    renderWithTheme(OvertimeModeField, {
      type: "MONTHLY_HOURS",
      monthlyHours: 15,
      value: "TRACK_ONLY",
      onchange: vi.fn(),
    });
    expect(select()).not.toBeDisabled();
    expect(select().value).toBe("TRACK_ONLY");
    expect(screen.queryByText(HINT)).not.toBeInTheDocument();
  });
});

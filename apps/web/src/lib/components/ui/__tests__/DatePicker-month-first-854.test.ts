// Issue #854 (D-854-07, AC-5) - DatePicker monthFirstOnly: only the 1st of a month is selectable in the
// calendar, a typed day that is not a 1st leaves the field invalid (no silent snapping), and without
// the prop the picker behaves as before. The popover is mounted through the `open` prop (jsdom).
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, waitFor } from "@testing-library/svelte";
import { renderWithTheme } from "$tests/test-utils";
import DatePicker from "../DatePicker.svelte";

afterEach(() => cleanup());

function mount(props: Record<string, unknown> = {}) {
  return renderWithTheme(DatePicker, { label: "Gültig ab", ...props });
}

function dayCell(day: string): HTMLElement {
  return Array.from(document.querySelectorAll(".dp-day")).find(
    (d) => d.textContent?.trim() === day && !d.hasAttribute("data-outside-month"),
  ) as HTMLElement;
}

function field(container: HTMLElement): HTMLElement {
  return container.querySelector('[role="group"]') as HTMLElement;
}

describe("DatePicker - monthFirstOnly", () => {
  it("makes every day but the 1st unavailable in the calendar", async () => {
    mount({ value: "2026-12-01", monthFirstOnly: true, open: true });
    await waitFor(() => expect(document.querySelectorAll(".dp-day").length).toBeGreaterThan(27));
    expect(dayCell("1").getAttribute("aria-disabled")).not.toBe("true");
    expect(dayCell("1").hasAttribute("data-unavailable")).toBe(false);
    for (const day of ["2", "15", "31"]) {
      const cell = dayCell(day);
      expect(
        cell.hasAttribute("data-unavailable") || cell.getAttribute("aria-disabled") === "true",
      ).toBe(true);
    }
  });

  it("is invalid for a typed day that is not a 1st, and keeps the value as typed", async () => {
    const onValueChange = vi.fn();
    const { container } = mount({ value: "2026-12-01", monthFirstOnly: true, onValueChange });
    expect(field(container).getAttribute("aria-invalid")).toBeNull();
    const day = container.querySelector('[role="spinbutton"]') as HTMLElement;
    day.focus();
    await fireEvent.keyDown(day, { key: "ArrowUp" });
    await waitFor(() => expect(onValueChange).toHaveBeenCalled());
    // Not snapped back to the 1st: the page reads the real value and names the rule.
    expect(onValueChange.mock.calls.at(-1)?.[0]).toBe("2026-12-02");
    await waitFor(() => expect(field(container).getAttribute("aria-invalid")).toBe("true"));
    expect(field(container).hasAttribute("data-invalid")).toBe(true);
  });

  it("an empty value is not invalid", () => {
    const { container } = mount({ value: null, monthFirstOnly: true });
    expect(field(container).getAttribute("aria-invalid")).toBeNull();
  });
});

describe("DatePicker - without monthFirstOnly", () => {
  it("leaves every day selectable and a mid-month value valid", async () => {
    const { container } = mount({ value: "2026-12-15", open: true });
    await waitFor(() => expect(document.querySelectorAll(".dp-day").length).toBeGreaterThan(27));
    expect(dayCell("15").hasAttribute("data-unavailable")).toBe(false);
    expect(dayCell("2").hasAttribute("data-unavailable")).toBe(false);
    expect(field(container).getAttribute("aria-invalid")).toBeNull();
  });
});

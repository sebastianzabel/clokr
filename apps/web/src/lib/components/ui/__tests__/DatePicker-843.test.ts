// Issue #843 (D-843-01 block 7) - DatePicker on bits-ui + @internationalized/date: German
// segments, ISO exchange, min/max bounds, weekday heads keyed by index (RESEARCH P7). Opening the
// popover by a synthetic click does not work in jsdom (RESEARCH Q1), so the open path is proven in
// the e2e of 843-29; the calendar is mounted here through the `open` prop.
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, screen, waitFor } from "@testing-library/svelte";
import { renderWithTheme } from "$tests/test-utils";
import DatePicker from "../DatePicker.svelte";
import pickerSource from "../DatePicker.svelte?raw";

afterEach(() => cleanup());

function mount(props: Record<string, unknown> = {}) {
  return renderWithTheme(DatePicker, { label: "Eintritt", ...props });
}

function segmentTexts(container: HTMLElement): string[] {
  return Array.from(container.querySelectorAll('[role="spinbutton"]')).map(
    (el) => el.textContent ?? "",
  );
}

describe("DatePicker - German segments", () => {
  it("renders 01.11.2026 for the ISO value 2026-11-01", () => {
    const { container } = mount({ value: "2026-11-01" });
    expect(segmentTexts(container)).toEqual(["01", "11", "2026"]);
    const group = container.querySelector('[role="group"]') as HTMLElement;
    expect(group.textContent?.replace(/\s/g, "")).toBe("01.11.2026");
  });

  it("renders empty segments for null", () => {
    const { container } = mount({ value: null });
    const texts = segmentTexts(container);
    expect(texts).toHaveLength(3);
    expect(texts.every((t) => !/\d/.test(t))).toBe(true);
  });

  it("names the field and the trigger in German", () => {
    const { container } = mount({ value: "2026-11-01" });
    expect(container.querySelector('[role="group"]')?.getAttribute("aria-label")).toBe("Eintritt");
    expect(screen.getByRole("button", { name: "Kalender öffnen" })).toBeTruthy();
  });

  it("speaks German part names", () => {
    const { container } = mount({ value: "2026-11-01" });
    const labels = Array.from(container.querySelectorAll('[role="spinbutton"]')).map((el) =>
      el.getAttribute("aria-label"),
    );
    expect(labels).toEqual(["Tag, ", "Monat, ", "Jahr, "]);
  });

  it("carries the FormField attrs on the field", () => {
    const { container } = mount({
      id: "start-field",
      describedBy: "start-help",
      invalid: true,
    });
    const group = container.querySelector('[role="group"]') as HTMLElement;
    expect(group.id).toBe("start-field");
    expect(group.getAttribute("aria-describedby")).toBe("start-help");
    expect(group.getAttribute("aria-invalid")).toBe("true");
  });
});

describe("DatePicker - ISO exchange", () => {
  it("writes an edited segment back as an ISO string", async () => {
    const onValueChange = vi.fn();
    const { container } = mount({ value: "2026-11-01", onValueChange });
    const day = container.querySelector('[role="spinbutton"]') as HTMLElement;
    day.focus();
    await fireEvent.keyDown(day, { key: "ArrowUp" });
    await waitFor(() => expect(onValueChange).toHaveBeenCalled());
    expect(onValueChange.mock.calls.at(-1)?.[0]).toBe("2026-11-02");
    await waitFor(() => expect(segmentTexts(container)[0]).toBe("02"));
  });

  it("treats an unparsable string as empty instead of throwing", () => {
    const { container } = mount({ value: "not-a-date" });
    expect(segmentTexts(container).every((t) => !/\d/.test(t))).toBe(true);
  });
});

describe("DatePicker - bounds", () => {
  it("turns min and max into calendar bounds: days outside them are disabled", async () => {
    mount({ value: "2026-11-15", min: "2026-11-10", max: "2026-11-20", open: true });
    await waitFor(() => expect(document.querySelectorAll(".dp-day").length).toBeGreaterThan(27));
    const state = (day: string) => {
      const el = Array.from(document.querySelectorAll(".dp-day")).find(
        (d) => d.textContent?.trim() === day && !d.hasAttribute("data-outside-month"),
      ) as HTMLElement;
      return el.getAttribute("aria-disabled");
    };
    expect(state("9")).toBe("true");
    expect(state("10")).toBe("false");
    expect(state("20")).toBe("false");
    expect(state("21")).toBe("true");
  });

  it("marks the bound day as selected", async () => {
    mount({ value: "2026-11-15", open: true });
    await waitFor(() => expect(document.querySelectorAll(".dp-day").length).toBeGreaterThan(27));
    const selected = Array.from(document.querySelectorAll(".dp-day[data-selected]"));
    expect(selected.map((d) => d.textContent?.trim())).toEqual(["15"]);
  });
});

describe("DatePicker - calendar", () => {
  it("mounts the Calendar part without each_key_duplicate and starts weeks on Monday", () => {
    const errors: unknown[] = [];
    const spy = vi.spyOn(console, "error").mockImplementation((...a) => {
      errors.push(a);
    });
    mount({ value: "2026-11-01", open: true });
    spy.mockRestore();
    expect(errors).toEqual([]);
    const heads = Array.from(document.querySelectorAll("th")).map((th) => th.textContent?.trim());
    expect(heads).toHaveLength(7);
    // German short heads: Montag first, Sonntag last; Di/Do and Sa/So differ, only narrow forms repeat.
    expect(heads[0]).toMatch(/^Mo/);
    expect(heads[6]).toMatch(/^So/);
  });

  it("labels the month navigation in German", async () => {
    mount({ value: "2026-11-01", open: true });
    expect(await screen.findByRole("button", { name: "Vorheriger Monat" })).toBeTruthy();
    expect(await screen.findByRole("button", { name: "Nächster Monat" })).toBeTruthy();
  });

  it("gives every calendar day cell at least 36 px in the stylesheet", () => {
    expect(pickerSource).toMatch(/\.dp-day[\s\S]*?width: 36px;[\s\S]*?height: 36px;/);
  });
});

describe("DatePicker - source", () => {
  it("keys the weekday heads by index and renders no HTML", () => {
    expect(pickerSource).toMatch(/weekdays as weekday, w \(w\)/);
    expect(pickerSource).not.toMatch(/\{@html/);
  });

  it("converts to and from ISO at the boundary only", () => {
    expect(pickerSource).toMatch(/parseDate/);
    expect(pickerSource).toMatch(/\.toString\(\)/);
  });
});

// Issue #843 (D-843-01 block 7) - DayGrid: weekday hours with a live sum in German notation.
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, screen } from "@testing-library/svelte";
import { renderWithTheme } from "$tests/test-utils";
import DayGrid from "../DayGrid.svelte";
import * as dayGridModule from "../DayGrid.svelte";

// #843: plain tsc types a .svelte import by the ambient default-only shim, so the module-script
// exports are typed by hand here (vitest and svelte-check resolve the real module).
type DayHours = Record<"mon" | "tue" | "wed" | "thu" | "fri" | "sat" | "sun", number | null>;
const { DAY_KEYS, clockHours, isValidDayHours, sumDayHours, workDayCount } =
  dayGridModule as unknown as {
    DAY_KEYS: readonly (keyof DayHours)[];
    clockHours: (hours: number) => string;
    workDayCount: (value: DayHours) => number;
    isValidDayHours: (hours: number | null) => boolean;
    sumDayHours: (value: DayHours) => number;
  };
import gridSource from "../DayGrid.svelte?raw";

afterEach(() => cleanup());

const FULL_WEEK = { mon: 8, tue: 8, wed: 8, thu: 8, fri: 7.5, sat: 0, sun: 0 };
const DAY_NAMES = ["Montag", "Dienstag", "Mittwoch", "Donnerstag", "Freitag", "Samstag", "Sonntag"];

function mount(extra: Record<string, unknown> = {}) {
  return renderWithTheme(DayGrid, {
    value: { ...FULL_WEEK },
    label: "Wochenstunden je Tag",
    ...extra,
  });
}

describe("DayGrid helpers", () => {
  it("formats German decimals", () => {
    expect(clockHours(39.5)).toBe("39:30 h");
    expect(clockHours(40)).toBe("40:00 h");
    expect(clockHours(0)).toBe("0:00 h");
    expect(clockHours(7.25)).toBe("7:15 h");
  });

  it("sums only valid days and rounds float noise away", () => {
    expect(sumDayHours({ ...FULL_WEEK })).toBe(39.5);
    expect(sumDayHours({ ...FULL_WEEK, mon: 30, tue: null })).toBe(23.5);
    expect(sumDayHours({ mon: 0.1, tue: 0.2, wed: 0, thu: 0, fri: 0, sat: 0, sun: 0 })).toBe(0.3);
  });

  it("range check 0...24 inclusive", () => {
    expect(isValidDayHours(0)).toBe(true);
    expect(isValidDayHours(24)).toBe(true);
    expect(isValidDayHours(24.25)).toBe(false);
    expect(isValidDayHours(-1)).toBe(false);
    expect(isValidDayHours(null)).toBe(false);
    expect(DAY_KEYS).toHaveLength(7);
  });
});

describe("DayGrid", () => {
  it("shows Mo...So and names every field with the full weekday", () => {
    const { container } = mount();
    const shorts = [...container.querySelectorAll(".dg-day-name")].map((n) => n.textContent);
    expect(shorts).toEqual(["Mo", "Di", "Mi", "Do", "Fr", "Sa", "So"]);
    for (const name of DAY_NAMES) expect(screen.getByLabelText(name)).toBeTruthy();
  });

  it("the group carries the given name", () => {
    mount();
    expect(screen.getByRole("group", { name: "Wochenstunden je Tag" })).toBeTruthy();
  });

  it("shows the sum 39,5 h for the given week", () => {
    const { container } = mount();
    expect(container.querySelector(".dg-sum-value")?.textContent).toBe("39:30 h");
  });

  it("editing a field updates the sum and calls onchange", async () => {
    const onchange = vi.fn();
    const { container } = mount({ onchange });
    await fireEvent.input(screen.getByLabelText("Samstag"), { target: { value: "4" } });
    expect(container.querySelector(".dg-sum-value")?.textContent).toBe("43:30 h");
    expect(onchange).toHaveBeenCalledTimes(1);
    expect(onchange.mock.calls[0][0].sat).toBe(4);
  });

  it("a value outside 0...24 shows a field error and stays out of the sum", async () => {
    const { container } = mount();
    const monday = screen.getByLabelText("Montag") as HTMLInputElement;
    expect(monday.hasAttribute("aria-invalid")).toBe(false);
    await fireEvent.input(monday, { target: { value: "25" } });
    expect(monday.getAttribute("aria-invalid")).toBe("true");
    const error = screen.getByText(/Montag: Gib eine Zahl von 0 bis 24 ein\./);
    expect(monday.getAttribute("aria-describedby")).toBe(error.id);
    expect(container.querySelector(".dg-sum-value")?.textContent).toBe("31:30 h");
  });

  it("an emptied field is an error, a negative one too", async () => {
    mount();
    const tuesday = screen.getByLabelText("Dienstag") as HTMLInputElement;
    await fireEvent.input(tuesday, { target: { value: "" } });
    expect(tuesday.getAttribute("aria-invalid")).toBe("true");
    await fireEvent.input(tuesday, { target: { value: "-1" } });
    expect(tuesday.getAttribute("aria-invalid")).toBe("true");
    await fireEvent.input(tuesday, { target: { value: "6" } });
    expect(tuesday.hasAttribute("aria-invalid")).toBe(false);
  });

  it("disabled disables all seven fields", () => {
    const { container } = mount({ disabled: true });
    const inputs = [...container.querySelectorAll("input")];
    expect(inputs).toHaveLength(7);
    expect(inputs.every((i) => i.disabled)).toBe(true);
  });

  it("several instances on one page get distinct ids", () => {
    const a = mount();
    const b = mount();
    const ids = [...document.querySelectorAll("[id]")].map((n) => n.id);
    expect(new Set(ids).size).toBe(ids.length);
    a.unmount();
    b.unmount();
  });

  it("container layout: one row from 760 px, tokens only, no uppercase or letter-spacing", () => {
    const style = gridSource.slice(gridSource.lastIndexOf("<style>"));
    const rules = style.replace(/\/\*[\s\S]*?\*\//g, "");
    expect(rules).toMatch(/\.day-grid\s*\{[^}]*container-type:\s*inline-size/);
    expect(rules).toMatch(/@container \(min-width: 760px\)[^}]*\{[^}]*repeat\(7,/);
    expect(rules).toMatch(/var\(--h-control\)/);
    expect(rules).not.toMatch(/#[0-9a-fA-F]{3,8}\b|rgba?\(/);
    expect(rules).not.toMatch(/italic|oblique|uppercase|letter-spacing|@media/);
    expect(gridSource).not.toContain("{@html");
  });

  it("the sum row names the working days and the week as a clock value, in a live region", () => {
    const { container } = mount({ sumTestId: "dg-test-sum" });
    const row = screen.getByTestId("dg-test-sum");
    expect(row.getAttribute("aria-live")).toBe("polite");
    expect(row.textContent).toContain(`${workDayCount({ ...FULL_WEEK })} Arbeitstage pro Woche`);
    expect(container.querySelector(".dg-sum-value")?.textContent).toBe("39:30 h");
    expect(
      workDayCount({ ...FULL_WEEK, mon: 8, tue: 0, wed: null, thu: 0, fri: 0, sat: 0, sun: 0 }),
    ).toBe(1);
  });
});

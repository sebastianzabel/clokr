// Issue #87 (D-05, D-13, AC-5) — the clock card's salon selector, mounted. The server decided
// whether to offer a choice; this component only renders the view it is handed.
import { describe, expect, it, vi } from "vitest";
import { fireEvent, screen } from "@testing-library/svelte";
import { renderWithTheme } from "../../../../__tests__/test-utils";
import ClockSalonSelect from "../ClockSalonSelect.svelte";
import type { ClockSalonView } from "$lib/dashboard/clock-salon";

const A = { id: `a-${crypto.randomUUID()}`, name: "Salon Nord" };
const B = { id: `b-${crypto.randomUUID()}`, name: "Salon Ost" };
const SELECT: ClockSalonView = { kind: "select", salons: [A, B] };

describe("ClockSalonSelect (Issue #87)", () => {
  it("tracer: shows the preselected salon and reports a change in one step", async () => {
    const onselect = vi.fn();
    renderWithTheme(ClockSalonSelect, { view: SELECT, value: B.id, onselect });
    const select = screen.getByRole("combobox", { name: "Salon" }) as HTMLSelectElement;
    expect(select.value).toBe(B.id);
    await fireEvent.change(select, { target: { value: A.id } });
    expect(onselect).toHaveBeenCalledWith(A.id);
  });

  it("renders nothing for the none view", () => {
    const { container } = renderWithTheme(ClockSalonSelect, {
      view: { kind: "none" } satisfies ClockSalonView,
      value: null,
      onselect: vi.fn(),
    });
    expect(screen.queryByRole("combobox")).toBeNull();
    expect(container.textContent?.trim()).toBe("");
  });

  it("lists the salons in server order and labels the field exactly „Salon“", () => {
    renderWithTheme(ClockSalonSelect, { view: SELECT, value: A.id, onselect: vi.fn() });
    const select = screen.getByRole("combobox", { name: "Salon" }) as HTMLSelectElement;
    expect(Array.from(select.options).map((o) => o.textContent?.trim())).toEqual([
      "Salon Nord",
      "Salon Ost",
    ]);
  });

  it("without a value the placeholder „Salon wählen“ is listed first and selected", () => {
    renderWithTheme(ClockSalonSelect, { view: SELECT, value: null, onselect: vi.fn() });
    const select = screen.getByRole("combobox", { name: "Salon" }) as HTMLSelectElement;
    expect(select.options[0].textContent?.trim()).toBe("Salon wählen");
    expect(select.options[0].disabled).toBe(true);
    expect(select.selectedIndex).toBe(0);
    expect(select.value).toBe("");
  });

  it("the fixed view is one neutral line and no combobox", () => {
    const { container } = renderWithTheme(ClockSalonSelect, {
      view: { kind: "fixed", salon: B } satisfies ClockSalonView,
      value: null,
      onselect: vi.fn(),
    });
    expect(screen.getByText("Heute erfasst in Salon Ost")).toBeTruthy();
    expect(screen.queryByRole("combobox")).toBeNull();
    expect(container.querySelector("button, .badge, .callout")).toBeNull();
  });

  it("the disabled prop disables the select", () => {
    renderWithTheme(ClockSalonSelect, {
      view: SELECT,
      value: B.id,
      disabled: true,
      onselect: vi.fn(),
    });
    expect((screen.getByRole("combobox", { name: "Salon" }) as HTMLSelectElement).disabled).toBe(
      true,
    );
  });

  it("AC-5: choosing a salon other than the preselected one marks nothing", async () => {
    const onselect = vi.fn();
    const { container } = renderWithTheme(ClockSalonSelect, {
      view: SELECT,
      value: B.id,
      onselect,
    });
    await fireEvent.change(screen.getByRole("combobox", { name: "Salon" }), {
      target: { value: A.id },
    });
    expect(onselect).toHaveBeenCalledWith(A.id);
    expect(container.querySelector('[role="alert"], [role="status"]')).toBeNull();
    expect(container.textContent).not.toMatch(/Abweich|Warnung|Fehler/);
  });
});

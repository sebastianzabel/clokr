// Issue #843 (D-843-01 block 6) - TableToolbar: pill search through the one normaliser, the
// „x von y“ count in a polite live region, the dashed „+ Filter“ popover trigger, one removable
// chip per active filter and „Filter zurücksetzen“. Opening a bits-ui popover by a synthetic click
// is limited in jsdom (RESEARCH Q1), so the opened state is tried here and proven in the e2e of
// 843-29 where jsdom cannot.
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, screen, waitFor } from "@testing-library/svelte";
import { mount, unmount } from "svelte";
import { renderWithTheme } from "$tests/test-utils";
import TableToolbar from "../TableToolbar.svelte";
import toolbarSource from "../TableToolbar.svelte?raw";

afterEach(() => cleanup());

const filters = [
  {
    key: "salon",
    label: "Salon",
    value: "",
    options: [
      { value: "n", label: "Salon Nord" },
      { value: "s", label: "Salon Süd" },
    ],
  },
  {
    key: "status",
    label: "Status",
    value: "",
    options: [
      { value: "aktiv", label: "Aktiv" },
      { value: "ausgetreten", label: "Ausgetreten" },
    ],
  },
];

function render(props: Record<string, unknown> = {}) {
  return renderWithTheme(TableToolbar, { count: 3, total: 10, filters, ...props });
}

describe("TableToolbar - search", () => {
  it("renders a labelled search input and emits the normalised query", async () => {
    const seen: string[] = [];
    let current = "";
    // A getter/setter pair stands in for `bind:query`, so the emitted value can be observed.
    const target = document.createElement("div");
    document.body.appendChild(target);
    const component = mount(TableToolbar, {
      target,
      props: {
        count: 3,
        total: 10,
        get query() {
          return current;
        },
        set query(v: string) {
          current = v;
          seen.push(v);
        },
      },
    });
    const input = screen.getByLabelText("Suchen") as HTMLInputElement;
    expect(input.type).toBe("search");
    await fireEvent.input(input, { target: { value: "  Ärztin " } });
    expect(seen.at(-1)).toBe("ärztin");
    await unmount(component);
    target.remove();
  });

  it("shows the reset button as soon as the query is active", async () => {
    const { container } = render();
    expect(container.querySelector(".tt-reset")).toBeNull();
    await fireEvent.input(screen.getByLabelText("Suchen"), { target: { value: "x" } });
    await waitFor(() => expect(container.querySelector(".tt-reset")).toBeTruthy());
  });

  it("keeps the space typed between two words while the query is normalised", async () => {
    render();
    const input = screen.getByLabelText("Suchen") as HTMLInputElement;
    await fireEvent.input(input, { target: { value: "anna " } });
    await Promise.resolve();
    expect(input.value).toBe("anna ");
  });

  it("shows an outside query in the input", () => {
    render({ query: "müller" });
    expect((screen.getByLabelText("Suchen") as HTMLInputElement).value).toBe("müller");
  });
});

describe("TableToolbar - count", () => {
  it("writes „3 von 10“ into a polite live region that exists from the start", () => {
    const { container } = render();
    const live = container.querySelector('[aria-live="polite"]') as HTMLElement;
    expect(live).toBeTruthy();
    expect(live.textContent?.trim()).toBe("3 von 10");
  });

  it("follows new counts", async () => {
    const { container, rerender } = render();
    await rerender({ count: 1, total: 10, filters });
    expect(container.querySelector('[aria-live="polite"]')?.textContent?.trim()).toBe("1 von 10");
  });
});

describe("TableToolbar - filters", () => {
  it("renders the dashed „+ Filter“ trigger with the popover wiring closed", () => {
    render();
    const trigger = screen.getByRole("button", { name: "+ Filter" });
    expect(trigger.getAttribute("aria-expanded")).toBe("false");
    expect(trigger.getAttribute("aria-haspopup")).toBe("dialog");
    expect(screen.queryAllByRole("radio")).toHaveLength(0);
  });

  it("renders no filter trigger without filters", () => {
    render({ filters: [] });
    expect(screen.queryByRole("button", { name: "+ Filter" })).toBeNull();
  });

  it("opens with the keyboard and offers every option of every filter", async () => {
    render();
    const trigger = screen.getByRole("button", { name: "+ Filter" });
    trigger.focus();
    await fireEvent.click(trigger);
    await waitFor(() => expect(trigger.getAttribute("aria-expanded")).toBe("true"));
    await waitFor(() => expect(screen.getAllByRole("radio").length).toBe(6));
    expect(screen.getByRole("radiogroup", { name: "Salon" })).toBeTruthy();
    expect(screen.getByRole("radio", { name: "Salon Nord" })).toBeTruthy();
    expect(screen.getAllByRole("radio", { name: "Alle" })).toHaveLength(2);
  });

  it("reports a picked option through onFilterChange", async () => {
    const onFilterChange = vi.fn();
    render({ onFilterChange });
    const trigger = screen.getByRole("button", { name: "+ Filter" });
    await fireEvent.click(trigger);
    await waitFor(() => expect(screen.getAllByRole("radio").length).toBe(6));
    await fireEvent.click(screen.getByRole("radio", { name: "Salon Süd" }));
    await waitFor(() => expect(onFilterChange).toHaveBeenCalledWith("salon", "s"));
  });

  it("shows one removable chip per active filter and removes it by its button", async () => {
    const onFilterChange = vi.fn();
    const active = [
      { ...filters[0], value: "n" },
      { ...filters[1], value: "ausgetreten" },
    ];
    const { container } = render({ filters: active, onFilterChange });
    expect(container.querySelectorAll(".chip")).toHaveLength(2);
    expect(screen.getByText("Salon: Salon Nord")).toBeTruthy();
    expect(screen.getByText("Status: Ausgetreten")).toBeTruthy();
    await fireEvent.click(screen.getByRole("button", { name: "Filter Salon entfernen" }));
    expect(onFilterChange).toHaveBeenCalledWith("salon", "");
  });

  it("shows no chip for an inactive filter or an unknown option value", () => {
    const { container } = render({ filters: [{ ...filters[0], value: "gone" }] });
    expect(container.querySelectorAll(".chip")).toHaveLength(0);
  });
});

describe("TableToolbar - reset", () => {
  it("is hidden while nothing is active", () => {
    render();
    expect(screen.queryByRole("button", { name: "Filter zurücksetzen" })).toBeNull();
  });

  it("calls onReset once when given, and nothing else", async () => {
    const onReset = vi.fn();
    const onFilterChange = vi.fn();
    render({ filters: [{ ...filters[0], value: "n" }], onReset, onFilterChange });
    await fireEvent.click(screen.getByRole("button", { name: "Filter zurücksetzen" }));
    expect(onReset).toHaveBeenCalledTimes(1);
    expect(onFilterChange).not.toHaveBeenCalled();
  });

  it("without onReset clears every active filter and the query", async () => {
    const onFilterChange = vi.fn();
    render({
      query: "anna",
      filters: [
        { ...filters[0], value: "n" },
        { ...filters[1], value: "aktiv" },
      ],
      onFilterChange,
    });
    await fireEvent.click(screen.getByRole("button", { name: "Filter zurücksetzen" }));
    expect(onFilterChange.mock.calls).toEqual([
      ["salon", ""],
      ["status", ""],
    ]);
    await waitFor(() =>
      expect((screen.getByLabelText("Suchen") as HTMLInputElement).value).toBe(""),
    );
  });
});

describe("TableToolbar - source", () => {
  it("is non-vacuous, uses the one normaliser and no {@html}", () => {
    expect(toolbarSource.length).toBeGreaterThan(500);
    expect(toolbarSource).toMatch(/normaliseSearch/);
    expect(toolbarSource).not.toMatch(/\{@html/);
    expect(toolbarSource).toMatch(/container-type: inline-size/);
    expect(toolbarSource).not.toMatch(/@media/);
  });
});

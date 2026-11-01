// Issue #541 (D-08, D-11) — the salon cell of one terminal row, mounted. The admin page cannot be
// mounted in tests (no `$app` alias), and `lint:ui-classes` does not scan this directory, so this
// mount test is the component's gate for every display state and for the rollback of a failed save.
import { describe, expect, it, vi } from "vitest";
import { screen, fireEvent } from "@testing-library/svelte";
import { tick } from "svelte";

import { renderWithTheme } from "$tests/test-utils";
import TerminalSalonCell from "../TerminalSalonCell.svelte";

const NONE = "Kein Salon – Salon aus dem Wochenmuster";
const salons = [
  { id: "s1", name: "Salon Nord" },
  { id: "s2", name: "Salon Süd" },
];

function terminal(over: Record<string, unknown> = {}) {
  return {
    id: "t1",
    name: "Eingang",
    salonId: null as string | null,
    salonName: null as string | null,
    salonActive: null as boolean | null,
    revokedAt: null as string | null,
    ...over,
  };
}

function mount(
  t: ReturnType<typeof terminal>,
  showOptions: boolean,
  onchange = vi.fn(async () => true),
) {
  const result = renderWithTheme(TerminalSalonCell, { terminal: t, salons, showOptions, onchange });
  return { ...result, onchange };
}

describe("TerminalSalonCell", () => {
  it("unbound active key with options: select with none-option selected, one option per salon, no badge", () => {
    mount(terminal(), true);
    const select = screen.getByLabelText("Salon für Eingang") as HTMLSelectElement;
    expect(select.value).toBe("");
    const labels = Array.from(select.options).map((o) => o.textContent?.trim());
    expect(labels).toEqual([NONE, "Salon Nord", "Salon Süd"]);
    expect(screen.queryByTestId("terminal-salon-inactive")).toBeNull();
  });

  it("bound to an active salon: that option is selected; change and removal call onchange", async () => {
    const { onchange } = mount(
      terminal({ salonId: "s1", salonName: "Salon Nord", salonActive: true }),
      true,
    );
    const select = screen.getByTestId("terminal-salon-select") as HTMLSelectElement;
    expect(select.value).toBe("s1");
    await fireEvent.change(select, { target: { value: "s2" } });
    expect(onchange).toHaveBeenLastCalledWith("s2");
    await tick();
    await fireEvent.change(select, { target: { value: "" } });
    expect(onchange).toHaveBeenLastCalledWith(null);
  });

  it("bound to a deactivated salon without options: select, disabled current option, badge, removable", async () => {
    const { onchange } = mount(
      terminal({ salonId: "gone", salonName: "Salon Alt", salonActive: false }),
      false,
    );
    const select = screen.getByTestId("terminal-salon-select") as HTMLSelectElement;
    expect(select.value).toBe("gone");
    const current = Array.from(select.options).find((o) => o.value === "gone");
    expect(current?.textContent?.trim()).toBe("Salon Alt (deaktiviert)");
    expect(current?.disabled).toBe(true);
    expect(screen.getByTestId("terminal-salon-inactive").textContent?.trim()).toBe(
      "Salon deaktiviert",
    );
    const none = Array.from(select.options).find((o) => o.value === "");
    expect(none?.disabled).toBe(false);
    await fireEvent.change(select, { target: { value: "" } });
    expect(onchange).toHaveBeenCalledWith(null);
  });

  it("unbound key without options: plain text, no select", () => {
    mount(terminal(), false);
    expect(screen.queryByTestId("terminal-salon-select")).toBeNull();
    expect(screen.getByTestId("terminal-salon-cell").textContent).toContain(NONE);
  });

  it("revoked key: no select; salon name or none-text; badge for an inactive binding", () => {
    const first = mount(terminal({ revokedAt: "2026-01-01T00:00:00Z" }), true);
    expect(screen.queryByTestId("terminal-salon-select")).toBeNull();
    expect(screen.getByTestId("terminal-salon-cell").textContent).toContain(NONE);
    first.unmount();

    const second = mount(
      terminal({
        revokedAt: "2026-01-01T00:00:00Z",
        salonId: "gone",
        salonName: "Salon Alt",
        salonActive: false,
      }),
      true,
    );
    expect(screen.queryByTestId("terminal-salon-select")).toBeNull();
    expect(screen.getByTestId("terminal-salon-cell").textContent).toContain("Salon Alt");
    expect(screen.getByTestId("terminal-salon-inactive")).toBeTruthy();
    second.unmount();
  });

  it("is disabled while saving and writes the previous value back when the save fails", async () => {
    let resolve!: (ok: boolean) => void;
    const onchange = vi.fn(() => new Promise<boolean>((r) => (resolve = r)));
    mount(terminal({ salonId: "s1", salonName: "Salon Nord", salonActive: true }), true, onchange);
    const select = screen.getByTestId("terminal-salon-select") as HTMLSelectElement;
    await fireEvent.change(select, { target: { value: "s2" } });
    await tick();
    expect(select.disabled).toBe(true);
    resolve(false);
    await tick();
    await tick();
    expect(select.disabled).toBe(false);
    expect(select.value).toBe("s1");
  });

  it("is a calm cell: no alert, no button, no link", () => {
    const { container } = mount(terminal(), true);
    expect(container.querySelector('[role="alert"], button, a')).toBeNull();
  });
});

// Issue #89 (D-10) - the opening-hours editor, mounted through a host that binds `days` and
// derives the errors with the real validator.
import { afterEach, describe, expect, it, vi } from "vitest";
import { fireEvent } from "@testing-library/svelte";
import { tick } from "svelte";

import { renderWithTheme } from "$tests/test-utils";
import { defaultOpeningHours } from "$lib/operator/opening-hours";
import type { OpeningHoursDay } from "$lib/operator/types";
import Host from "./OpeningHoursEditorHost.svelte";

function byId<T extends HTMLElement = HTMLInputElement>(id: string): T | null {
  return document.querySelector<T>(`[data-testid="${id}"]`);
}

function must<T extends HTMLElement = HTMLInputElement>(id: string): T {
  const found = byId<T>(id);
  if (!found) throw new Error(`missing test id ${id}`);
  return found;
}

function mount(initial: OpeningHoursDay[] = defaultOpeningHours()) {
  const onChange = vi.fn();
  renderWithTheme(Host, { initial, onChange }, "nacht");
  return { onChange };
}

function last(onChange: ReturnType<typeof vi.fn>): OpeningHoursDay[] {
  return onChange.mock.calls.at(-1)?.[0] as OpeningHoursDay[];
}

afterEach(() => {
  document.body.innerHTML = "";
});

describe("OpeningHoursEditor", () => {
  it("renders seven rows Montag to Sonntag under the legend", () => {
    mount();
    expect(document.querySelector("legend")).toHaveTextContent("Öffnungszeiten");
    const names = Array.from({ length: 7 }, (_, i) => must(`op-salon-hours-${i}`).textContent);
    expect(names[0]).toContain("Montag");
    expect(names[1]).toContain("Dienstag");
    expect(names[2]).toContain("Mittwoch");
    expect(names[3]).toContain("Donnerstag");
    expect(names[4]).toContain("Freitag");
    expect(names[5]).toContain("Samstag");
    expect(names[6]).toContain("Sonntag");
    for (const text of names) expect(text).toContain("Geöffnet");
  });

  it("shows the default: Montag-Freitag open with 09:00 to 18:00, weekend closed", () => {
    mount();
    for (let i = 0; i < 5; i++) {
      expect(must(`op-salon-hours-${i}-open`)).toBeChecked();
      expect(must(`op-salon-hours-${i}-from`).value).toBe("09:00");
      expect(must(`op-salon-hours-${i}-to`).value).toBe("18:00");
    }
    for (const i of [5, 6]) {
      expect(must(`op-salon-hours-${i}-open`)).not.toBeChecked();
      expect(byId(`op-salon-hours-${i}-from`)).toBeNull();
      expect(byId(`op-salon-hours-${i}-to`)).toBeNull();
      expect(must(`op-salon-hours-${i}-closed`)).toHaveTextContent("Geschlossen");
    }
  });

  it("labels the time inputs with the weekday for assistive technology", () => {
    mount();
    expect(must("op-salon-hours-0-from")).toHaveAttribute("aria-label", "Montag von");
    expect(must("op-salon-hours-0-to")).toHaveAttribute("aria-label", "Montag bis");
    expect(must("op-salon-hours-4-from")).toHaveAttribute("aria-label", "Freitag von");
    expect(must("op-salon-hours-0-from")).toHaveAttribute("type", "time");
  });

  it("hides the times of a day when Geöffnet is unchecked and keeps them in the data", async () => {
    const { onChange } = mount();
    await fireEvent.click(must("op-salon-hours-2-open"));
    await tick();
    expect(byId("op-salon-hours-2-from")).toBeNull();
    expect(byId("op-salon-hours-2-to")).toBeNull();
    expect(must("op-salon-hours-2-closed")).toHaveTextContent("Geschlossen");
    expect(last(onChange)[2]).toEqual({ day: 2, open: "09:00", close: "18:00", closed: true });
  });

  it("opens a closed day again with its kept times", async () => {
    mount();
    await fireEvent.click(must("op-salon-hours-6-open"));
    await tick();
    expect(must("op-salon-hours-6-from").value).toBe("09:00");
    expect(must("op-salon-hours-6-to").value).toBe("18:00");
    expect(byId("op-salon-hours-6-closed")).toBeNull();
  });

  it("writes an edited time back to the bound days, leaving the other days alone", async () => {
    const { onChange } = mount();
    const from = must("op-salon-hours-1-from");
    from.value = "08:30";
    await fireEvent.input(from);
    await tick();
    const days = last(onChange);
    expect(days[1]).toEqual({ day: 1, open: "08:30", close: "18:00", closed: false });
    expect(days[0]).toEqual({ day: 0, open: "09:00", close: "18:00", closed: false });
  });

  it("reports open >= close under the row and marks the inputs invalid", async () => {
    mount();
    expect(byId("op-salon-hours-3-error")).toBeNull();
    const to = must("op-salon-hours-3-to");
    to.value = "09:00";
    await fireEvent.input(to);
    await tick();
    const error = must("op-salon-hours-3-error");
    expect(error).toHaveTextContent("Die Öffnungszeit muss vor der Schließzeit liegen.");
    expect(error.id).toBe("op-salon-hours-3-error");
    expect(must("op-salon-hours-3-to")).toHaveAttribute("aria-invalid", "true");
    expect(must("op-salon-hours-3-to")).toHaveAttribute("aria-describedby", error.id);
    expect(byId("op-salon-hours-2-error")).toBeNull();
  });

  it("clears the error once the day is closed", async () => {
    mount();
    const to = must("op-salon-hours-3-to");
    to.value = "09:00";
    await fireEvent.input(to);
    await tick();
    expect(byId("op-salon-hours-3-error")).not.toBeNull();
    await fireEvent.click(must("op-salon-hours-3-open"));
    await tick();
    expect(byId("op-salon-hours-3-error")).toBeNull();
  });
});

// Issue #89 (AC-89-02/03/04) - the salon section, mounted with API callbacks.
//
// Pinned here: the create trigger and a per-row edit trigger open the right dialog, a saved salon
// closes the dialog, reloads the list exactly once, toasts and returns focus to the trigger, a
// refused save keeps the dialog open without a toast, and the Standardsalon's hours and the active
// salon count reach the dialog.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent } from "@testing-library/svelte";
import { get } from "svelte/store";
import { tick } from "svelte";

import { renderWithTheme } from "$tests/test-utils";
import { OperatorApiError } from "$lib/operator/client";
import { defaultOpeningHours } from "$lib/operator/opening-hours";
import type { OperatorSalon } from "$lib/operator/types";
import { toasts } from "$stores/toast";
import SalonsSection from "../SalonsSection.svelte";

function byId<T extends HTMLElement = HTMLElement>(id: string): T | null {
  return document.querySelector<T>(`[data-testid="${id}"]`);
}

function el<T extends HTMLElement = HTMLInputElement>(id: string): T {
  const found = byId<T>(id);
  if (!found) throw new Error(`missing test id ${id}`);
  return found;
}

async function typeInto(id: string, value: string) {
  const input = el<HTMLInputElement>(id);
  input.value = value;
  await fireEvent.input(input);
}

async function choose(id: string, value: string) {
  const select = el<HTMLSelectElement>(id);
  select.value = value;
  await fireEvent.change(select);
}

async function settle() {
  for (let i = 0; i < 8; i++) {
    await Promise.resolve();
    await tick();
  }
}

function salon(overrides: Partial<OperatorSalon> & { id: string }): OperatorSalon {
  return {
    name: "Salon Beispiel",
    street: null,
    postalCode: null,
    city: null,
    openingHours: defaultOpeningHours(),
    federalState: "NIEDERSACHSEN",
    isActive: true,
    deactivatedAt: null,
    createdAt: "2026-01-01T00:00:00.000Z",
    isDefault: false,
    coupling: null,
    ...overrides,
  };
}

const STANDARD_HOURS = defaultOpeningHours().map((d) => ({ ...d, open: "09:30", close: "17:30" }));
const ONE: OperatorSalon[] = [
  salon({ id: "s1", name: "Hauptsalon", isDefault: true, openingHours: STANDARD_HOURS }),
];
const TWO: OperatorSalon[] = [...ONE, salon({ id: "s2", name: "Zweitsalon" })];

function mount(salons: OperatorSalon[] = TWO, overrides: Record<string, unknown> = {}) {
  const onCreate = vi.fn().mockResolvedValue({});
  const onUpdate = vi.fn().mockResolvedValue({});
  const onReload = vi.fn().mockResolvedValue(undefined);
  renderWithTheme(
    SalonsSection,
    { tenantId: "t1", salons, onCreate, onUpdate, onReload, ...overrides },
    "nacht",
  );
  return { onCreate, onUpdate, onReload };
}

let toastMessages: string[] = [];
let unsubscribe: () => void = () => {};

beforeEach(() => {
  toastMessages = [];
  unsubscribe = toasts.subscribe((list) => {
    toastMessages = list.map((t) => t.message);
  });
});

afterEach(() => {
  unsubscribe();
  document.body.innerHTML = "";
  for (const t of get(toasts)) toasts.remove(t.id);
});

describe("SalonsSection", () => {
  it("renders the Salons section with the create action and the table", () => {
    mount();
    expect(el("op-salons-section")).not.toBeNull();
    expect(el("op-salon-create")).toHaveTextContent("Salon anlegen");
    expect(document.body).toHaveTextContent("Standorte des Mandanten");
    expect(el("op-salons-table")).not.toBeNull();
    expect(byId("op-salon-dialog")).toBeNull();
  });

  it("the create trigger opens an empty create dialog prefilled with the Standardsalon hours", async () => {
    mount();
    await fireEvent.click(el("op-salon-create"));
    await tick();
    expect(el("op-salon-dialog")).toHaveAttribute("data-mode", "create");
    expect(el<HTMLInputElement>("op-salon-name").value).toBe("");
    expect(el<HTMLSelectElement>("op-salon-federal-state").value).toBe("");
    expect(el<HTMLInputElement>("op-salon-hours-0-from").value).toBe("09:30");
    expect(el<HTMLInputElement>("op-salon-hours-0-to").value).toBe("17:30");
  });

  it("each row's edit action opens the dialog filled with that salon", async () => {
    mount();
    const edit = el("op-salon-edit-s2");
    expect(edit).toHaveAttribute("aria-label", "Salon Zweitsalon bearbeiten");
    await fireEvent.click(edit);
    await tick();
    expect(el("op-salon-dialog")).toHaveAttribute("data-mode", "edit");
    expect(el<HTMLInputElement>("op-salon-name").value).toBe("Zweitsalon");
  });

  it("passes the active salon count: the hint shows for exactly one", async () => {
    mount(ONE);
    await fireEvent.click(el("op-salon-create"));
    await tick();
    expect(byId("op-salon-single-salon-hint")).not.toBeNull();
    document.body.innerHTML = "";
    mount(TWO);
    await fireEvent.click(el("op-salon-create"));
    await tick();
    expect(byId("op-salon-single-salon-hint")).toBeNull();
    document.body.innerHTML = "";
    mount([...ONE, salon({ id: "s9", name: "Altsalon", isActive: false })]);
    await fireEvent.click(el("op-salon-create"));
    await tick();
    expect(byId("op-salon-single-salon-hint")).not.toBeNull();
  });

  it("a created salon closes the dialog, reloads once, toasts and refocuses the trigger", async () => {
    const { onCreate, onReload } = mount();
    const trigger = el("op-salon-create");
    await fireEvent.click(trigger);
    await tick();
    await typeInto("op-salon-name", "Neuer Salon");
    await choose("op-salon-federal-state", "BAYERN");
    await fireEvent.click(el("op-salon-submit"));
    await settle();

    expect(onCreate).toHaveBeenCalledTimes(1);
    expect(onCreate.mock.calls[0]?.[0]).toBe("t1");
    expect(onCreate.mock.calls[0]?.[1]).toMatchObject({
      name: "Neuer Salon",
      federalState: "BAYERN",
    });
    expect(onReload).toHaveBeenCalledTimes(1);
    expect(toastMessages).toContain("Salon angelegt.");
    expect(byId("op-salon-dialog")).toBeNull();
    expect(document.activeElement).toBe(trigger);
  });

  it("an edited salon sends the patch for that salon, reloads once and refocuses its edit button", async () => {
    const { onUpdate, onReload, onCreate } = mount();
    const trigger = el("op-salon-edit-s2");
    await fireEvent.click(trigger);
    await tick();
    await typeInto("op-salon-name", "Umbenannt");
    await fireEvent.click(el("op-salon-submit"));
    await settle();

    expect(onCreate).not.toHaveBeenCalled();
    expect(onUpdate).toHaveBeenCalledWith("t1", "s2", { name: "Umbenannt" });
    expect(onReload).toHaveBeenCalledTimes(1);
    expect(toastMessages).toContain("Salon gespeichert.");
    expect(byId("op-salon-dialog")).toBeNull();
    expect(document.activeElement).toBe(el("op-salon-edit-s2"));
  });

  it("a refused save keeps the dialog open, shows the reason, does not toast and does not reload", async () => {
    const onUpdate = vi
      .fn()
      .mockRejectedValue(new OperatorApiError(409, "FEDERAL_STATE_IN_USE", "x"));
    const { onReload } = mount(TWO, { onUpdate });
    await fireEvent.click(el("op-salon-edit-s2"));
    await tick();
    await choose("op-salon-federal-state", "BAYERN");
    await fireEvent.click(el("op-salon-submit"));
    await settle();

    expect(el("op-salon-reason")).toHaveAttribute("data-code", "FEDERAL_STATE_IN_USE");
    expect(byId("op-salon-dialog")).not.toBeNull();
    expect(toastMessages).toEqual([]);
    expect(onReload).not.toHaveBeenCalled();
  });

  it("a stale-list refusal reloads the list while the dialog stays open", async () => {
    const onUpdate = vi
      .fn()
      .mockRejectedValue(new OperatorApiError(409, "SALON_ALREADY_COUPLED", "x"));
    const { onReload } = mount(TWO, { onUpdate });
    await fireEvent.click(el("op-salon-edit-s2"));
    await tick();
    await typeInto("op-salon-name", "Anders");
    await fireEvent.click(el("op-salon-submit"));
    await settle();

    expect(onReload).toHaveBeenCalledTimes(1);
    expect(el("op-salon-error")).toHaveTextContent("Der Salon ist bereits gekoppelt.");
    expect(byId("op-salon-dialog")).not.toBeNull();
  });

  it("cancel closes the dialog without a call and returns focus to the trigger", async () => {
    const { onCreate, onReload } = mount();
    const trigger = el("op-salon-create");
    await fireEvent.click(trigger);
    await tick();
    await fireEvent.click(el("op-salon-cancel"));
    await settle();
    expect(byId("op-salon-dialog")).toBeNull();
    expect(onCreate).not.toHaveBeenCalled();
    expect(onReload).not.toHaveBeenCalled();
    expect(document.activeElement).toBe(trigger);
  });

  it("offers no delete anywhere", () => {
    mount();
    expect(document.body.textContent).not.toMatch(/löschen|entfernen/i);
  });
});

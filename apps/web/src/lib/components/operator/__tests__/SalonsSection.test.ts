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
  const onDeactivate = vi.fn().mockResolvedValue({});
  const onActivate = vi.fn().mockResolvedValue({});
  const onReload = vi.fn().mockResolvedValue(undefined);
  renderWithTheme(
    SalonsSection,
    {
      tenantId: "t1",
      salons,
      onCreate,
      onUpdate,
      onDeactivate,
      onActivate,
      onReload,
      ...overrides,
    },
    "nacht",
  );
  return { onCreate, onUpdate, onDeactivate, onActivate, onReload };
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

  it("a create refused with SALON_QUOTA_REACHED shows the console's own reason, not the server sentence (Phase 566)", async () => {
    const serverSentence = "Ihr Anbieter schaltet das frei (Satz fuer Mandanten).";
    const onCreate = vi
      .fn()
      .mockRejectedValue(new OperatorApiError(409, "SALON_QUOTA_REACHED", serverSentence));
    mount(TWO, { onCreate });
    await fireEvent.click(el("op-salon-create"));
    await tick();
    await typeInto("op-salon-name", "Neuer Salon");
    await choose("op-salon-federal-state", "BAYERN");
    await fireEvent.click(el("op-salon-submit"));
    await settle();

    const shown = el("op-salon-error");
    expect(shown).toHaveTextContent("Salon-Kontingent erreicht.");
    expect(shown).toHaveTextContent("Abschnitt „Pakete“");
    expect(shown).not.toHaveTextContent("Ihr Anbieter");
    expect(byId("op-salon-dialog")).not.toBeNull();
    expect(toastMessages).toEqual([]);
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

  describe("deactivate and activate", () => {
    const refusal = (code: string, message = "server text") =>
      new OperatorApiError(409, code, message);

    async function openDeactivate(id = "s2") {
      await fireEvent.click(el(`op-salon-deactivate-${id}`));
      await settle();
    }

    async function confirmDeactivate() {
      const dialog = document.querySelector('[role="dialog"]') as HTMLElement;
      const button = Array.from(dialog.querySelectorAll("button")).find(
        (b) => b.textContent?.trim() === "Salon deaktivieren",
      ) as HTMLElement;
      await fireEvent.click(button);
      await settle();
    }

    it("deactivate asks first: a danger dialog names the salon and the consequences", async () => {
      const { onDeactivate } = mount();
      await openDeactivate();
      const dialog = document.querySelector('[role="dialog"]') as HTMLElement;
      expect(dialog).toHaveTextContent("Salon deaktivieren?");
      expect(dialog).toHaveTextContent("„Zweitsalon“ wird deaktiviert.");
      expect(dialog).toHaveTextContent("Laufende Einsatzsalon-Zuordnungen enden.");
      expect(dialog).toHaveTextContent("nicht wiederhergestellt");
      expect(dialog.querySelector(".btn-danger")).toHaveTextContent("Salon deaktivieren");
      expect(onDeactivate).not.toHaveBeenCalled();
    });

    it("a confirmed deactivation calls the callback, closes, toasts and reloads once", async () => {
      const { onDeactivate, onReload } = mount();
      await openDeactivate();
      await confirmDeactivate();
      expect(onDeactivate).toHaveBeenCalledWith("t1", "s2");
      expect(document.querySelector('[role="dialog"]')).toBeNull();
      expect(toastMessages).toContain("Salon deaktiviert.");
      expect(onReload).toHaveBeenCalledTimes(1);
    });

    it("HOME_SALON_IN_USE stays inside the open dialog with its code, no toast, no reload", async () => {
      const { onDeactivate, onReload } = mount();
      onDeactivate.mockRejectedValue(refusal("HOME_SALON_IN_USE"));
      await openDeactivate();
      await confirmDeactivate();
      const error = el("op-salon-deactivate-error");
      expect(error).toHaveAttribute("data-code", "HOME_SALON_IN_USE");
      expect(error).toHaveTextContent("noch Stammsalon von Mitarbeitenden");
      expect(error.textContent).not.toMatch(/\d/);
      expect(document.querySelector('[role="dialog"]')).not.toBeNull();
      expect(toastMessages).not.toContain("Salon deaktiviert.");
      expect(onReload).not.toHaveBeenCalled();
      expect(byId("op-salons-notice")).toBeNull();
    });

    it("LAST_ACTIVE_SALON from a stale page is shown in the dialog", async () => {
      const { onDeactivate } = mount();
      onDeactivate.mockRejectedValue(refusal("LAST_ACTIVE_SALON"));
      await openDeactivate();
      await confirmDeactivate();
      expect(el("op-salon-deactivate-error")).toHaveAttribute("data-code", "LAST_ACTIVE_SALON");
      expect(el("op-salon-deactivate-error")).toHaveTextContent("letzte aktive Salon");
      expect(document.querySelector('[role="dialog"]')).not.toBeNull();
    });

    it("a dialog error is gone when the dialog is opened again", async () => {
      const { onDeactivate } = mount();
      onDeactivate.mockRejectedValueOnce(refusal("HOME_SALON_IN_USE"));
      await openDeactivate();
      await confirmDeactivate();
      expect(byId("op-salon-deactivate-error")).not.toBeNull();
      const cancel = Array.from(document.querySelectorAll("button")).find(
        (b) => b.textContent?.trim() === "Abbrechen",
      ) as HTMLElement;
      await fireEvent.click(cancel);
      await settle();
      await openDeactivate();
      expect(byId("op-salon-deactivate-error")).toBeNull();
    });

    it("ALREADY_INACTIVE on deactivate closes the dialog, shows the notice and reloads", async () => {
      const { onDeactivate, onReload } = mount();
      onDeactivate.mockRejectedValue(refusal("ALREADY_INACTIVE"));
      await openDeactivate();
      await confirmDeactivate();
      expect(document.querySelector('[role="dialog"]')).toBeNull();
      const notice = el("op-salons-notice");
      expect(notice).toHaveAttribute("data-code", "ALREADY_INACTIVE");
      expect(notice).toHaveAttribute("role", "alert");
      expect(notice).toHaveTextContent("Salon „Zweitsalon“: Der Salon ist bereits deaktiviert.");
      expect(onReload).toHaveBeenCalledTimes(1);
    });

    it("activation needs no confirmation: callback, toast and reload", async () => {
      const salons = [...TWO, salon({ id: "s3", name: "Altsalon", isActive: false })];
      const { onActivate, onReload } = mount(salons);
      await fireEvent.click(el("op-salon-activate-s3"));
      await settle();
      expect(document.querySelector('[role="dialog"]')).toBeNull();
      expect(onActivate).toHaveBeenCalledWith("t1", "s3");
      expect(toastMessages).toContain("Salon aktiviert.");
      expect(onReload).toHaveBeenCalledTimes(1);
    });

    it("ALREADY_ACTIVE lands in the notice with its code and reloads; a later success clears it", async () => {
      const salons = [...TWO, salon({ id: "s3", name: "Altsalon", isActive: false })];
      const { onActivate, onReload } = mount(salons);
      onActivate.mockRejectedValueOnce(refusal("ALREADY_ACTIVE"));
      await fireEvent.click(el("op-salon-activate-s3"));
      await settle();
      const notice = el("op-salons-notice");
      expect(notice).toHaveAttribute("data-code", "ALREADY_ACTIVE");
      expect(notice).toHaveTextContent("Salon „Altsalon“: Der Salon ist bereits aktiv.");
      expect(onReload).toHaveBeenCalledTimes(1);
      expect(toastMessages).not.toContain("Salon aktiviert.");

      await fireEvent.click(el("op-salon-activate-s3"));
      await settle();
      expect(byId("op-salons-notice")).toBeNull();
      expect(toastMessages).toContain("Salon aktiviert.");
    });

    it("activation refused with SALON_QUOTA_REACHED / MODULE_NOT_BOOKED shows the console's own reason by code (Phase 566)", async () => {
      const salons = [...TWO, salon({ id: "s3", name: "Altsalon", isActive: false })];
      const { onActivate } = mount(salons);
      onActivate.mockRejectedValueOnce(
        refusal("SALON_QUOTA_REACHED", "Ihr Anbieter schaltet das frei."),
      );
      await fireEvent.click(el("op-salon-activate-s3"));
      await settle();
      const quota = el("op-salons-notice");
      expect(quota).toHaveAttribute("data-code", "SALON_QUOTA_REACHED");
      expect(quota).toHaveTextContent("Salon-Kontingent erreicht.");
      expect(quota).toHaveTextContent("Abschnitt „Pakete“");
      expect(quota).not.toHaveTextContent("Ihr Anbieter");

      onActivate.mockRejectedValueOnce(
        refusal("MODULE_NOT_BOOKED", "Ihr Anbieter schaltet es frei."),
      );
      await fireEvent.click(el("op-salon-activate-s3"));
      await settle();
      const module = el("op-salons-notice");
      expect(module).toHaveAttribute("data-code", "MODULE_NOT_BOOKED");
      expect(module).toHaveTextContent("Zusatzmodul ist nicht gebucht");
      expect(module).not.toHaveTextContent("Ihr Anbieter");
    });

    it("a missing salon (404) lands in the notice as SALON_NOT_FOUND", async () => {
      const salons = [...TWO, salon({ id: "s3", name: "Altsalon", isActive: false })];
      const { onActivate } = mount(salons);
      onActivate.mockRejectedValue(new OperatorApiError(404, undefined, "Salon nicht gefunden"));
      await fireEvent.click(el("op-salon-activate-s3"));
      await settle();
      const notice = el("op-salons-notice");
      expect(notice).toHaveAttribute("data-code", "SALON_NOT_FOUND");
      expect(notice).toHaveTextContent("Salon „Altsalon“: Salon nicht gefunden.");
    });

    it("TENANT_DEACTIVATED on activate shows the notice and reloads", async () => {
      const salons = [...TWO, salon({ id: "s3", name: "Altsalon", isActive: false })];
      const { onActivate, onReload } = mount(salons);
      onActivate.mockRejectedValue(refusal("TENANT_DEACTIVATED"));
      await fireEvent.click(el("op-salon-activate-s3"));
      await settle();
      expect(el("op-salons-notice")).toHaveAttribute("data-code", "TENANT_DEACTIVATED");
      expect(onReload).toHaveBeenCalledTimes(1);
    });

    it("a second click while an activation is in flight is ignored", async () => {
      const salons = [...TWO, salon({ id: "s3", name: "Altsalon", isActive: false })];
      let release!: () => void;
      const { onActivate } = mount(salons);
      onActivate.mockImplementation(
        () =>
          new Promise<void>((r) => {
            release = r;
          }),
      );
      await fireEvent.click(el("op-salon-activate-s3"));
      await fireEvent.click(el("op-salon-activate-s3"));
      expect(onActivate).toHaveBeenCalledTimes(1);
      release();
      await settle();
    });

    it("exactly one active salon: note visible, Deaktivieren aria-disabled and silent", async () => {
      const { onDeactivate } = mount(ONE);
      expect(el("op-salons-last-active-note")).toBeVisible();
      await fireEvent.click(el("op-salon-deactivate-s1"));
      await settle();
      expect(el("op-salon-deactivate-s1")).toHaveAttribute("aria-disabled", "true");
      expect(document.querySelector('[role="dialog"]')).toBeNull();
      expect(onDeactivate).not.toHaveBeenCalled();
    });

    it("two active salons: no last-active note", () => {
      mount(TWO);
      expect(byId("op-salons-last-active-note")).toBeNull();
    });

    it("a deactivated tenant freezes create, edit, deactivate and activate with the hint as reason", async () => {
      const salons = [...TWO, salon({ id: "s3", name: "Altsalon", isActive: false })];
      const props = mount(salons, { tenantDeactivated: true });
      const hint = el("op-salons-tenant-frozen-hint");
      expect(hint).toHaveTextContent(
        "Der Mandant ist deaktiviert. Änderungen sind erst nach der Reaktivierung möglich.",
      );
      for (const id of [
        "op-salon-create",
        "op-salon-edit-s1",
        "op-salon-deactivate-s2",
        "op-salon-activate-s3",
      ]) {
        const control = el<HTMLButtonElement>(id);
        expect(control.disabled).toBe(true);
        expect(control.getAttribute("aria-describedby")).toBe(hint.id);
        // HTMLElement.click() honours `disabled` like a real click; a dispatched event would not.
        control.click();
      }
      await settle();
      expect(document.querySelector('[role="dialog"]')).toBeNull();
      expect(props.onActivate).not.toHaveBeenCalled();
      expect(props.onDeactivate).not.toHaveBeenCalled();
    });

    it("an active tenant shows no frozen hint and enabled controls", () => {
      mount(TWO);
      expect(byId("op-salons-tenant-frozen-hint")).toBeNull();
      expect(el<HTMLButtonElement>("op-salon-create").disabled).toBe(false);
    });

    it("the section offers no delete anywhere, also with a dialog open", async () => {
      mount();
      await openDeactivate();
      expect(document.body.textContent).not.toMatch(/löschen|entfernen|delete/i);
    });
  });
});

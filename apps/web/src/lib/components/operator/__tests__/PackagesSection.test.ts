// Phase 566 (D-08) - the "Pakete" section of the operator's tenant page, mounted. The component
// only drafts and asks; the page owns the API call, so it is driven with plain callbacks.
//
// Pinned here: one checkbox per module with its German name, the stored state on screen, the dirty
// hint and the exact PUT body, the non-blocking warning when the effective limit lies below the
// number of active salons, the 1-500 quota check, the frozen state of a deactivated tenant and the
// reason line of a refused save.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent } from "@testing-library/svelte";
import { get } from "svelte/store";
import { tick } from "svelte";

import { renderWithTheme } from "$tests/test-utils";
import { OperatorApiError } from "$lib/operator/client";
import type { OperatorTenant, OperatorTenantPackages } from "$lib/operator/types";
import { TENANT_MODULES } from "$lib/packages/tenant-modules";
import { toasts } from "$stores/toast";
import PackagesSection from "../PackagesSection.svelte";

function byId<T extends HTMLElement = HTMLElement>(id: string): T | null {
  return document.querySelector<T>(`[data-testid="${id}"]`);
}

function el<T extends HTMLElement = HTMLInputElement>(id: string): T {
  const found = byId<T>(id);
  if (!found) throw new Error(`missing test id ${id}`);
  return found;
}

async function settle() {
  for (let i = 0; i < 8; i++) {
    await Promise.resolve();
    await tick();
  }
}

async function typeQuota(value: string) {
  const input = el<HTMLInputElement>("package-quota");
  input.value = value;
  await fireEvent.input(input);
}

async function toggle(module: string) {
  await fireEvent.click(el<HTMLInputElement>(`package-${module}`));
}

function tenantWith(
  packages: Partial<OperatorTenantPackages> = {},
  overrides: Partial<OperatorTenant> = {},
): OperatorTenant {
  return {
    id: "tenant-1",
    name: "Beispiel Friseure GmbH",
    slug: "beispiel-friseure",
    federalState: "NIEDERSACHSEN",
    createdAt: "2026-03-05T12:00:00.000Z",
    deactivatedAt: null,
    deactivatedReason: null,
    packages: { bookedModules: [], salonQuota: 1, activeSalonCount: 1, ...packages },
    ...overrides,
  };
}

function mount(tenant: OperatorTenant, onSave?: ReturnType<typeof vi.fn>) {
  const save = onSave ?? vi.fn().mockImplementation(async () => tenant);
  const onSaved = vi.fn();
  renderWithTheme(
    PackagesSection,
    { tenant, onSave: save, onSaved, tenantDeactivated: tenant.deactivatedAt !== null },
    "nacht",
  );
  return { onSave: save, onSaved };
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

describe("PackagesSection", () => {
  it("shows the Grundversion line and one checkbox per module with its German name", () => {
    mount(tenantWith());
    expect(document.body).toHaveTextContent("Pakete");
    expect(el("package-base")).toHaveTextContent("Grundversion – immer enthalten");
    expect(TENANT_MODULES).toHaveLength(4);
    for (const module of TENANT_MODULES) {
      expect(el(`package-${module}`)).toHaveAttribute("type", "checkbox");
    }
    const text = el("package-modules").textContent ?? "";
    for (const name of ["Ketten-Paket", "Integrationen", "Hardware-Stempeln", "Auswertungen"]) {
      expect(text).toContain(name);
    }
    expect(text).toContain("Phorest-Synchronisation und API-Schlüssel");
  });

  it("shows the stored state: booked modules ticked, quota and counts on screen", () => {
    mount(
      tenantWith({
        bookedModules: ["CHAIN", "HARDWARE_CLOCK"],
        salonQuota: 3,
        activeSalonCount: 2,
      }),
    );
    expect(el<HTMLInputElement>("package-CHAIN").checked).toBe(true);
    expect(el<HTMLInputElement>("package-INTEGRATIONS").checked).toBe(false);
    expect(el<HTMLInputElement>("package-HARDWARE_CLOCK").checked).toBe(true);
    expect(el<HTMLInputElement>("package-ANALYTICS").checked).toBe(false);
    expect(el<HTMLInputElement>("package-quota").value).toBe("3");
    expect(el("package-active-salons")).toHaveTextContent("2");
    expect(el("package-effective-limit")).toHaveTextContent("3");
    expect(el<HTMLButtonElement>("packages-save").disabled).toBe(true);
    expect(document.body).not.toHaveTextContent("Nicht gespeichert");
  });

  it("the effective limit is 1 without the Ketten-Paket, whatever the quota says", () => {
    mount(tenantWith({ bookedModules: ["INTEGRATIONS"], salonQuota: 7 }));
    expect(el("package-effective-limit")).toHaveTextContent("1");
  });

  it("toggling a box shows the dirty hint and enables Speichern", async () => {
    mount(tenantWith());
    await toggle("HARDWARE_CLOCK");
    expect(document.body).toHaveTextContent("Nicht gespeichert");
    expect(el<HTMLButtonElement>("packages-save").disabled).toBe(false);
    // Ticking and unticking again returns to the stored state: nothing to save.
    await toggle("HARDWARE_CLOCK");
    expect(document.body).not.toHaveTextContent("Nicht gespeichert");
    expect(el<HTMLButtonElement>("packages-save").disabled).toBe(true);
  });

  it("saves exactly { bookedModules, salonQuota } in canonical order, toasts and reports the stored tenant", async () => {
    const stored = tenantWith({ bookedModules: ["CHAIN", "HARDWARE_CLOCK"], salonQuota: 3 });
    const { onSave, onSaved } = mount(
      tenantWith({ bookedModules: ["CHAIN"], salonQuota: 3 }),
      vi.fn().mockResolvedValue(stored),
    );
    // Ticked out of declaration order on purpose: ANALYTICS first, then HARDWARE_CLOCK.
    await toggle("ANALYTICS");
    await toggle("HARDWARE_CLOCK");
    await toggle("ANALYTICS");
    await fireEvent.click(el("packages-save"));
    await settle();

    expect(onSave).toHaveBeenCalledTimes(1);
    expect(onSave.mock.calls[0]?.[0]).toStrictEqual({
      bookedModules: ["CHAIN", "HARDWARE_CLOCK"],
      salonQuota: 3,
    });
    expect(toastMessages).toContain("Pakete gespeichert.");
    expect(onSaved).toHaveBeenCalledWith(stored);
  });

  it("sends the changed quota as a number", async () => {
    const { onSave } = mount(tenantWith({ bookedModules: ["CHAIN"], salonQuota: 3 }));
    await typeQuota("12");
    await fireEvent.click(el("packages-save"));
    await settle();
    expect(onSave.mock.calls[0]?.[0]).toStrictEqual({ bookedModules: ["CHAIN"], salonQuota: 12 });
  });

  describe("warning when the limit lies below the active salons (D-06)", () => {
    it("appears when the Ketten-Paket is unticked on a tenant with 3 active salons, and still saves", async () => {
      const { onSave } = mount(
        tenantWith({ bookedModules: ["CHAIN"], salonQuota: 5, activeSalonCount: 3 }),
      );
      expect(byId("package-quota-warning")).toBeNull();
      await toggle("CHAIN");
      expect(el("package-effective-limit")).toHaveTextContent("1");
      expect(el("package-quota-warning")).toHaveTextContent(
        "Bestehende Salons bleiben aktiv; nur weitere können nicht aktiviert werden.",
      );
      expect(el<HTMLButtonElement>("packages-save").disabled).toBe(false);
      await fireEvent.click(el("packages-save"));
      await settle();
      expect(onSave.mock.calls[0]?.[0]).toStrictEqual({ bookedModules: [], salonQuota: 5 });
    });

    it("appears when the quota is lowered below the active count, and disappears when raised again", async () => {
      mount(tenantWith({ bookedModules: ["CHAIN"], salonQuota: 5, activeSalonCount: 3 }));
      await typeQuota("2");
      expect(byId("package-quota-warning")).not.toBeNull();
      await typeQuota("3");
      expect(byId("package-quota-warning")).toBeNull();
    });

    it("is absent for a Grundversion tenant with one active salon", () => {
      mount(tenantWith());
      expect(byId("package-quota-warning")).toBeNull();
    });
  });

  describe("quota check", () => {
    it.each(["0", "501", "", "abc", "2.5", "-1"])(
      "%j shows the inline error and keeps Speichern disabled",
      async (value) => {
        const { onSave } = mount(tenantWith({ bookedModules: ["CHAIN"], salonQuota: 3 }));
        await toggle("ANALYTICS");
        await typeQuota(value);
        expect(el("package-quota-error")).toHaveTextContent("von 1 bis 500");
        expect(el("package-quota")).toHaveAttribute("aria-invalid", "true");
        expect(el<HTMLButtonElement>("packages-save").disabled).toBe(true);
        expect(onSave).not.toHaveBeenCalled();
      },
    );

    it.each(["1", "500"])("%s is accepted", async (value) => {
      mount(tenantWith({ bookedModules: ["CHAIN"], salonQuota: 3 }));
      await typeQuota(value);
      expect(byId("package-quota-error")).toBeNull();
      expect(el<HTMLButtonElement>("packages-save").disabled).toBe(false);
    });
  });

  it("a deactivated tenant freezes every control and says why", () => {
    mount(
      tenantWith(
        { bookedModules: ["CHAIN"], salonQuota: 3 },
        { deactivatedAt: "2026-09-30T12:00:00.000Z", deactivatedReason: "Vertrag beendet" },
      ),
    );
    expect(el("op-packages-tenant-frozen-hint")).toHaveTextContent("Der Mandant ist deaktiviert.");
    for (const module of TENANT_MODULES) {
      expect(el<HTMLInputElement>(`package-${module}`).matches(":disabled")).toBe(true);
    }
    expect(el<HTMLInputElement>("package-quota").disabled).toBe(true);
    expect(el<HTMLButtonElement>("packages-save").disabled).toBe(true);
  });

  it("a refused save shows the reason line by code, keeps the draft and does not toast", async () => {
    const onSave = vi
      .fn()
      .mockRejectedValue(
        new OperatorApiError(409, "TENANT_DEACTIVATED", "Server sentence that must not show"),
      );
    const { onSaved } = mount(tenantWith(), onSave);
    await toggle("INTEGRATIONS");
    await fireEvent.click(el("packages-save"));
    await settle();

    const shown = el("packages-error");
    expect(shown).toHaveTextContent("Der Mandant ist deaktiviert.");
    expect(shown).not.toHaveTextContent("Server sentence");
    expect(el<HTMLInputElement>("package-INTEGRATIONS").checked).toBe(true);
    expect(document.body).toHaveTextContent("Nicht gespeichert");
    expect(toastMessages).toEqual([]);
    expect(onSaved).not.toHaveBeenCalled();
  });

  it("an unknown refusal shows the server's German sentence", async () => {
    const onSave = vi
      .fn()
      .mockRejectedValue(new OperatorApiError(400, undefined, "Validierungsfehler"));
    mount(tenantWith(), onSave);
    await toggle("INTEGRATIONS");
    await fireEvent.click(el("packages-save"));
    await settle();
    expect(el("packages-error")).toHaveTextContent("Validierungsfehler");
  });

  it("a reload that only changes the active salon count keeps the unsaved draft", async () => {
    const view = renderWithTheme(
      PackagesSection,
      {
        tenant: tenantWith({ bookedModules: ["CHAIN"], salonQuota: 3, activeSalonCount: 1 }),
        onSave: vi.fn(),
        onSaved: vi.fn(),
        tenantDeactivated: false,
      },
      "nacht",
    );
    await toggle("ANALYTICS");
    await view.rerender({
      tenant: tenantWith({ bookedModules: ["CHAIN"], salonQuota: 3, activeSalonCount: 2 }),
    });
    await settle();
    expect(el<HTMLInputElement>("package-ANALYTICS").checked).toBe(true);
    expect(el("package-active-salons")).toHaveTextContent("2");
  });

  it("the draft restarts from the stored packages when those change", async () => {
    const view = renderWithTheme(
      PackagesSection,
      {
        tenant: tenantWith({ bookedModules: ["CHAIN"], salonQuota: 3 }),
        onSave: vi.fn(),
        onSaved: vi.fn(),
        tenantDeactivated: false,
      },
      "nacht",
    );
    await toggle("ANALYTICS");
    await view.rerender({
      tenant: tenantWith({ bookedModules: ["CHAIN", "ANALYTICS"], salonQuota: 4 }),
    });
    await settle();
    expect(el<HTMLInputElement>("package-ANALYTICS").checked).toBe(true);
    expect(el<HTMLInputElement>("package-quota").value).toBe("4");
    expect(document.body).not.toHaveTextContent("Nicht gespeichert");
  });
});

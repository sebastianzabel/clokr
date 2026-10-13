// Issue #89 (D-14) - the tenant section of the operator's detail page, mounted. The component
// only asks; the page owns the API calls, so it is driven with plain callbacks.
import { afterEach, describe, expect, it, vi } from "vitest";
import { fireEvent } from "@testing-library/svelte";
import { tick } from "svelte";

import { renderWithTheme } from "$tests/test-utils";
import type { OperatorTenant } from "$lib/operator/types";
import TenantMasterData from "../TenantMasterData.svelte";

function byId<T extends HTMLElement = HTMLElement>(id: string): T | null {
  return document.querySelector<T>(`[data-testid="${id}"]`);
}

function el<T extends HTMLElement = HTMLElement>(id: string): T {
  const found = byId<T>(id);
  if (!found) throw new Error(`missing test id ${id}`);
  return found;
}

async function settle() {
  for (let i = 0; i < 6; i++) {
    await Promise.resolve();
    await tick();
  }
}

const ACTIVE: OperatorTenant = {
  id: "tenant-1",
  name: "Beispiel Friseure GmbH",
  slug: "beispiel-friseure",
  federalState: "NIEDERSACHSEN",
  createdAt: "2026-03-05T12:00:00.000Z",
  deactivatedAt: null,
  deactivatedReason: null,
};

const DEACTIVATED: OperatorTenant = {
  ...ACTIVE,
  deactivatedAt: "2026-09-30T12:00:00.000Z",
  deactivatedReason: "Vertrag beendet",
};

function mount(tenant: OperatorTenant, onRename = vi.fn().mockResolvedValue(undefined)) {
  renderWithTheme(TenantMasterData, { tenant, onRename }, "nacht");
  return { onRename };
}

afterEach(() => {
  document.body.innerHTML = "";
});

describe("TenantMasterData - facts", () => {
  it("lists Name, Kurzname, Bundesland, Angelegt and Status", () => {
    mount(ACTIVE);
    const labels = [...document.querySelectorAll("dt")].map((dt) => dt.textContent?.trim());
    expect(labels).toEqual(["Name", "Kurzname", "Bundesland", "Angelegt", "Status"]);
    expect(el("op-tenant-name")).toHaveTextContent("Beispiel Friseure GmbH");
    expect(el("op-tenant-slug")).toHaveTextContent("beispiel-friseure");
    expect(el("op-tenant-federal-state")).toHaveTextContent("Niedersachsen");
    expect(document.querySelector("dl")).toHaveTextContent("05.03.2026");
  });

  it("marks an active tenant with data-state active and shows no deactivation notice", () => {
    mount(ACTIVE);
    expect(el("op-tenant-status")).toHaveAttribute("data-state", "active");
    expect(byId("op-tenant-deactivated-notice")).toBeNull();
  });

  it("marks a deactivated tenant and shows the date and the reason", () => {
    mount(DEACTIVATED);
    expect(el("op-tenant-status")).toHaveAttribute("data-state", "deactivated");
    expect(el("op-tenant-deactivated-notice")).toHaveTextContent(
      "Deaktiviert am 30.09.2026. Grund: Vertrag beendet",
    );
  });

  it("omits the reason sentence when none is stored", () => {
    mount({ ...DEACTIVATED, deactivatedReason: null });
    const text = el("op-tenant-deactivated-notice").textContent ?? "";
    expect(text).toContain("Deaktiviert am 30.09.2026.");
    expect(text).not.toContain("Grund");
  });
});

describe("TenantMasterData - action sets", () => {
  it("offers rename, resend and deactivate for an active tenant", () => {
    mount(ACTIVE);
    expect(byId("op-tenant-rename")).not.toBeNull();
    expect(byId("op-tenant-resend")).not.toBeNull();
    expect(byId("op-tenant-deactivate")).not.toBeNull();
    expect(byId("op-tenant-reactivate")).toBeNull();
  });

  it("offers rename and reactivate for a deactivated tenant, without resend and deactivate", () => {
    mount(DEACTIVATED);
    expect(byId("op-tenant-rename")).not.toBeNull();
    expect(byId("op-tenant-reactivate")).not.toBeNull();
    expect(byId("op-tenant-resend")).toBeNull();
    expect(byId("op-tenant-deactivate")).toBeNull();
  });

  it("keeps the three actions in one row outside any header slot", () => {
    mount(ACTIVE);
    const row = el("op-tenant-actions");
    expect(row.closest("header")).toBeNull();
    expect(row.querySelectorAll("button").length).toBeGreaterThanOrEqual(3);
  });
});

describe("TenantMasterData - rename", () => {
  it("opens the rename dialog from the current name and passes the trimmed name on", async () => {
    const { onRename } = mount(ACTIVE);
    expect(byId("op-tenant-rename-dialog")).toBeNull();
    await fireEvent.click(el("op-tenant-rename"));
    await settle();

    const input = el<HTMLInputElement>("op-tenant-rename-input");
    expect(input.value).toBe("Beispiel Friseure GmbH");
    input.value = "  Umbenannt  ";
    await fireEvent.input(input);
    await fireEvent.click(el("op-tenant-rename-submit"));
    await settle();

    expect(onRename).toHaveBeenCalledWith("Umbenannt");
    expect(byId("op-tenant-rename-dialog")).toBeNull();
  });
});

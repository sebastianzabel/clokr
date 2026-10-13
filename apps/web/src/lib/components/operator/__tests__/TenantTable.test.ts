// Issue #89 - TenantTable mounted. Operator components sit outside the lint:ui-classes scope, so
// styling is proven by a control comparison, not assumed.
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { beforeAll, describe, expect, it } from "vitest";

import { renderWithTheme } from "$tests/test-utils";
import type { OperatorTenant } from "$lib/operator/types";
import TenantTable from "../TenantTable.svelte";

function tenant(overrides: Partial<OperatorTenant> & { id: string }): OperatorTenant {
  return {
    name: "Beispiel Friseure GmbH",
    slug: "beispiel-friseure",
    federalState: "NIEDERSACHSEN",
    createdAt: "2026-01-05T08:00:00.000Z",
    deactivatedAt: null,
    deactivatedReason: null,
    ...overrides,
  };
}

const ACTIVE = tenant({ id: "t-active" });
const OFF = tenant({
  id: "t-off",
  name: "Altbetrieb",
  slug: "altbetrieb",
  federalState: "BAYERN",
  deactivatedAt: "2026-03-01T08:00:00.000Z",
  deactivatedReason: "Vertrag beendet",
});

function many(count: number): OperatorTenant[] {
  return Array.from({ length: count }, (_, i) =>
    tenant({ id: `t-${i}`, name: `Betrieb ${i}`, slug: `betrieb-${i}` }),
  );
}

function appCss(): string {
  try {
    return readFileSync(fileURLToPath(new URL("../../../../app.css", import.meta.url)), "utf8");
  } catch {
    return readFileSync(resolve(process.cwd(), "src/app.css"), "utf8");
  }
}

/** Typed lookup by test id; the testing-library queries return a union that breaks matcher typing. */
function byId(id: string): HTMLElement | null {
  return document.querySelector<HTMLElement>(`[data-testid="${id}"]`);
}

function rows(): number {
  return document.querySelectorAll('[data-testid^="op-tenant-row-"]').length;
}

beforeAll(() => {
  const style = document.createElement("style");
  style.textContent = appCss();
  document.head.appendChild(style);
});

describe("TenantTable", () => {
  it("renders one row per tenant with a link to the tenant page", () => {
    renderWithTheme(TenantTable, { tenants: [ACTIVE, OFF], page: 1, pageSize: 25 }, "nacht");
    expect(rows()).toBe(2);
    const link = byId("op-tenant-link-t-active");
    expect(link).toHaveAttribute("href", "/betreiber/mandanten/t-active");
    expect(link).toHaveTextContent("Beispiel Friseure GmbH");
    expect(byId("op-tenant-row-t-active")).toHaveTextContent("beispiel-friseure");
  });

  it("shows the Bundesland label and the date as dd.MM.yyyy", () => {
    renderWithTheme(TenantTable, { tenants: [ACTIVE, OFF], page: 1, pageSize: 25 }, "nacht");
    expect(byId("op-tenant-row-t-active")).toHaveTextContent("Niedersachsen");
    expect(byId("op-tenant-row-t-off")).toHaveTextContent("Bayern");
    expect(byId("op-tenant-row-t-active")).toHaveTextContent("05.01.2026");
    expect(byId("op-tenant-row-t-active")).not.toHaveTextContent("NIEDERSACHSEN");
  });

  it("marks an active tenant Aktiv with no reason line", () => {
    renderWithTheme(TenantTable, { tenants: [ACTIVE, OFF], page: 1, pageSize: 25 }, "nacht");
    const status = byId("op-tenant-status-t-active");
    expect(status).toHaveAttribute("data-state", "active");
    expect(status).toHaveTextContent("Aktiv");
    expect(byId("op-tenant-row-t-active")).not.toHaveTextContent("Grund:");
  });

  it("marks a deactivated tenant Deaktiviert and shows its reason line", () => {
    renderWithTheme(TenantTable, { tenants: [ACTIVE, OFF], page: 1, pageSize: 25 }, "nacht");
    const status = byId("op-tenant-status-t-off");
    expect(status).toHaveAttribute("data-state", "deactivated");
    expect(status).toHaveTextContent("Deaktiviert");
    expect(byId("op-tenant-row-t-off")).toHaveTextContent("Grund: Vertrag beendet");
  });

  it("omits the reason line when a deactivated tenant has no reason", () => {
    const bare = tenant({ id: "t-bare", deactivatedAt: "2026-03-01T08:00:00.000Z" });
    renderWithTheme(TenantTable, { tenants: [bare], page: 1, pageSize: 25 }, "nacht");
    expect(byId("op-tenant-status-t-bare")).toHaveAttribute("data-state", "deactivated");
    expect(byId("op-tenant-row-t-bare")).not.toHaveTextContent("Grund:");
  });

  it("shows 25 rows on page 1 and 5 on page 2 for 30 tenants", () => {
    const list = many(30);
    renderWithTheme(TenantTable, { tenants: list, page: 1, pageSize: 25 }, "nacht");
    expect(rows()).toBe(25);
    expect(byId("op-tenants-pagination")).not.toBeNull();
    expect(byId("op-tenant-row-t-0")).not.toBeNull();
    expect(byId("op-tenant-row-t-25")).toBeNull();
  });

  it("shows the remaining 5 tenants on page 2", () => {
    renderWithTheme(TenantTable, { tenants: many(30), page: 2, pageSize: 25 }, "nacht");
    expect(rows()).toBe(5);
    expect(byId("op-tenant-row-t-25")).not.toBeNull();
    expect(byId("op-tenant-row-t-29")).not.toBeNull();
    expect(byId("op-tenant-row-t-24")).toBeNull();
  });

  it("renders no pagination for 25 tenants or fewer", () => {
    renderWithTheme(TenantTable, { tenants: many(25), page: 1, pageSize: 25 }, "nacht");
    expect(rows()).toBe(25);
    expect(byId("op-tenants-pagination")).toBeNull();
  });

  it("offers the page sizes 25, 50 and 100 and the Mandant labels", () => {
    renderWithTheme(TenantTable, { tenants: many(30), page: 1, pageSize: 25 }, "nacht");
    const select = document.querySelector<HTMLSelectElement>("select.pag-select");
    expect(select).not.toBeNull();
    expect([...(select as HTMLSelectElement).options].map((o) => o.value)).toEqual([
      "25",
      "50",
      "100",
    ]);
    expect(byId("op-tenants-pagination")).toHaveTextContent("30 Mandanten");
  });

  it("has a screen-reader caption and the five column headers", () => {
    renderWithTheme(TenantTable, { tenants: [ACTIVE], page: 1, pageSize: 25 }, "nacht");
    const table = byId("op-tenants-table") as HTMLElement;
    expect(table.querySelector("caption")).toHaveTextContent("Mandanten");
    const headers = [...table.querySelectorAll("thead th")].map((th) => th.textContent?.trim());
    expect(headers).toEqual(["Name", "Kurzname", "Bundesland", "Angelegt", "Status"]);
  });

  it("is styled: the table differs from a control element with an invented class", () => {
    renderWithTheme(TenantTable, { tenants: [ACTIVE], page: 1, pageSize: 25 }, "nacht");
    const table = byId("op-tenants-table") as HTMLElement;
    const control = document.createElement("table");
    control.className = "no-such-class-89";
    document.body.appendChild(control);
    expect(getComputedStyle(table).borderCollapse).toBe("collapse");
    expect(getComputedStyle(control).borderCollapse).not.toBe("collapse");
  });

  it("renders a 200-character name whole (the list clamps it by CSS, never by truncating text)", () => {
    const long = tenant({ id: "t-long", name: "N".repeat(200) });
    renderWithTheme(TenantTable, { tenants: [long], page: 1, pageSize: 25 }, "nacht");
    expect(byId("op-tenant-link-t-long")).toHaveTextContent("N".repeat(200));
  });

  // vitest does not process component <style> blocks, so the wrapping rules are pinned on the
  // source: scoped styles are the only place they exist.
  it("declares wrapping and clamping rules and never forbids wrapping (source)", () => {
    const source = readFileSync(
      resolve(process.cwd(), "src/lib/components/operator/TenantTable.svelte"),
      "utf8",
    );
    expect(source).toContain("overflow-wrap: anywhere");
    expect(source).toContain("-webkit-line-clamp: 2");
    expect(source).not.toContain("nowrap");
  });
});

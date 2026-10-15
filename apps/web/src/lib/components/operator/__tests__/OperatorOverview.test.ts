// Issue #90 - OperatorOverview mounted. Operator components sit outside the lint:ui-classes scope,
// so styling is proven by a control comparison, not assumed.
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { beforeAll, describe, expect, it } from "vitest";

import { renderWithTheme } from "$tests/test-utils";
import type { OperatorDashboard } from "$lib/operator/types";
import OperatorOverview from "../OperatorOverview.svelte";

function dashboard(overrides: Partial<OperatorDashboard["totals"]> = {}, days = 30) {
  const value: OperatorDashboard = {
    inactivityDays: days,
    totals: {
      tenants: 5,
      activeTenants: 4,
      deactivatedTenants: 1,
      activeSalons: 9,
      activeEmployees: 42,
      inactiveTenants: 2,
      ...overrides,
    },
    tenants: [],
  };
  return value;
}

function appCss(): string {
  try {
    return readFileSync(fileURLToPath(new URL("../../../../app.css", import.meta.url)), "utf8");
  } catch {
    return readFileSync(resolve(process.cwd(), "src/app.css"), "utf8");
  }
}

function byId(id: string): HTMLElement {
  const el = document.querySelector<HTMLElement>(`[data-testid="${id}"]`);
  if (!el) throw new Error(`missing test id ${id}`);
  return el;
}

beforeAll(() => {
  const style = document.createElement("style");
  style.textContent = appCss();
  document.head.appendChild(style);
});

describe("OperatorOverview", () => {
  it("shows the four labels with their values", () => {
    renderWithTheme(OperatorOverview, { dashboard: dashboard() }, "nacht");
    expect(byId("op-overview-tenants")).toHaveTextContent("Mandanten");
    expect(byId("op-overview-tenants")).toHaveTextContent("5");
    expect(byId("op-overview-inactive")).toHaveTextContent("Inaktive Mandanten");
    expect(byId("op-overview-inactive")).toHaveTextContent("2");
    expect(byId("op-overview-salons")).toHaveTextContent("Aktive Salons");
    expect(byId("op-overview-salons")).toHaveTextContent("9");
    expect(byId("op-overview-employees")).toHaveTextContent("Aktive Mitarbeitende");
    expect(byId("op-overview-employees")).toHaveTextContent("42");
  });

  it("shows the delta lines", () => {
    renderWithTheme(OperatorOverview, { dashboard: dashboard() }, "nacht");
    expect(byId("op-overview-tenants")).toHaveTextContent("4 aktiv · 1 deaktiviert");
    expect(byId("op-overview-inactive")).toHaveTextContent("keine Anmeldung seit 30 Tagen");
  });

  it("takes the inactivity threshold from the response (45 days)", () => {
    renderWithTheme(OperatorOverview, { dashboard: dashboard({}, 45) }, "nacht");
    expect(byId("op-overview-inactive")).toHaveTextContent("keine Anmeldung seit 45 Tagen");
    expect(byId("op-overview-inactive")).not.toHaveTextContent("30 Tagen");
  });

  it("formats numbers in de-DE (1234 as 1.234)", () => {
    renderWithTheme(OperatorOverview, { dashboard: dashboard({ activeEmployees: 1234 }) }, "nacht");
    expect(byId("op-overview-employees")).toHaveTextContent("1.234");
  });

  it("uses the warn tone only when there are inactive tenants", () => {
    renderWithTheme(OperatorOverview, { dashboard: dashboard({ inactiveTenants: 2 }) }, "nacht");
    expect(byId("op-overview-inactive").querySelector(".kpi-delta-warn")).not.toBeNull();
  });

  it("uses the neutral tone for zero inactive tenants", () => {
    renderWithTheme(OperatorOverview, { dashboard: dashboard({ inactiveTenants: 0 }) }, "nacht");
    expect(byId("op-overview-inactive").querySelector(".kpi-delta-warn")).toBeNull();
    expect(byId("op-overview-inactive").querySelector(".kpi-delta")).not.toBeNull();
  });

  it("is styled: a tile differs from a control element with an invented class", () => {
    renderWithTheme(OperatorOverview, { dashboard: dashboard() }, "nacht");
    const kpi = byId("op-overview-tenants").querySelector<HTMLElement>(".kpi") as HTMLElement;
    const control = document.createElement("article");
    control.className = "no-such-class-90";
    document.body.appendChild(control);
    expect(getComputedStyle(kpi).display).toBe("flex");
    expect(getComputedStyle(control).display).not.toBe("flex");
  });
});

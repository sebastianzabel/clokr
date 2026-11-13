// Issue #854 (plan 14) - the tabs of System › Integrationen: each is offered under the alternatives of its own
// registry section only (T-854-35), the page opens under their union (D-854-05).
import { describe, expect, it } from "vitest";

import { APP_ROUTES } from "$lib/nav/routes";
import { INTEGRATIONEN_TABS, visibleIntegrationenTabs } from "$lib/settings/integrationen";
import { pageAlternatives } from "$lib/settings/settings-pages";

const tabsOf = (permissions: string[]) =>
  visibleIntegrationenTabs({ permissions }).map((tab) => tab.value);

describe("Integrationen tabs", () => {
  it("lists the three tabs in strip order", () => {
    expect(INTEGRATIONEN_TABS.map((tab) => tab.label)).toEqual([
      "WLAN-Anwesenheit",
      "NFC-Terminals",
      "API-Schlüssel",
    ]);
  });

  it("the presence permission opens the WLAN tab alone", () => {
    expect(tabsOf(["presence-source:manage:ZUGEWIESEN"])).toEqual(["wlan"]);
  });

  it("a System permission opens the two moved tabs, never the WLAN tab", () => {
    for (const permission of [
      "terminal:manage:ZUGEWIESEN",
      "api-key:manage:ZUGEWIESEN",
      "tenant-settings:read:ZUGEWIESEN",
      "tenant-settings:update:ZUGEWIESEN",
    ]) {
      expect(tabsOf([permission]), permission).toEqual(["terminals", "schluessel"]);
    }
  });

  it("holds nothing, sees nothing; holds everything, sees all three", () => {
    expect(tabsOf([])).toEqual([]);
    expect(tabsOf(["presence-source:manage:ZUGEWIESEN", "terminal:manage:ZUGEWIESEN"])).toEqual([
      "wlan",
      "terminals",
      "schluessel",
    ]);
  });

  it("the route opens under exactly the union of the tabs' sections", () => {
    const route = APP_ROUTES.find((entry) => entry.href === "/verwalten/system/integrationen");
    expect(route?.requires).toEqual(pageAlternatives("/verwalten/system/integrationen"));
    expect(pageAlternatives("/verwalten/system/integrationen")).toHaveLength(5);
  });
});

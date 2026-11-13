// Issue #854 (D-854-03) - the tabs of Verwalten › System › Integrationen: WLAN-Anwesenheit, NFC-Terminals and
// API-Schlüssel. The page merges sections of two old pages (the integrations page and System) and opens under
// the union of their gates (D-854-05), so each tab is offered only under the alternatives of its own registry
// section. Presentation only; the API's 403 stays the authority. No runes and no `$app` imports on purpose.

import type { PermissionHolder } from "$lib/permissions";
import { mayOpenSection, settingsSection } from "$lib/settings/settings-pages";

export interface IntegrationenTab {
  value: "wlan" | "terminals" | "schluessel";
  label: string;
  /** The registry section the tab shows. */
  section: string;
}

/** The tabs of Integrationen in strip order. */
export const INTEGRATIONEN_TABS: readonly IntegrationenTab[] = [
  { value: "wlan", label: "WLAN-Anwesenheit", section: "integrationen-wlan" },
  { value: "terminals", label: "NFC-Terminals", section: "integrationen-terminals" },
  { value: "schluessel", label: "API-Schlüssel", section: "integrationen-api-schluessel" },
];

/** The tabs `user` may open (T-854-35): a tab is offered under the alternatives of its own section only. */
export function visibleIntegrationenTabs(
  user: PermissionHolder | null | undefined,
): IntegrationenTab[] {
  return INTEGRATIONEN_TABS.filter((tab) => mayOpenSection(user, settingsSection(tab.section)));
}

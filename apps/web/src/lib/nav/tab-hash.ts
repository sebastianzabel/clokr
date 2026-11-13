// Issue #854 (D-854-03) - the ONE rule that keeps the selected tab of a Verwalten page in the URL
// hash and restores it on reload. Pages with panel tabs (`PageTabs`) read it once on mount through
// `tabFromHash()` and write it on every change through `writeTabHash()`.
//
// The hash is attacker-controlled input like any other part of the URL, so reading is an allow-list:
// only an id of the tabs the page currently shows (or an alias that maps onto one of them) opens a
// tab; everything else is the first tab. A tab the page hides for this person is simply not in
// `tabIds`, so a crafted link can never open it (T-854-05).
import { replaceState } from "$app/navigation";
import { page } from "$app/state";

/**
 * The tab a URL hash selects. `hash` may carry the leading `#`. An alias (an old or shorter name)
 * is mapped to its tab first; the result is the first of `tabIds` for an empty, unknown or hidden
 * hash. `tabIds` must not be empty.
 */
export function tabFromHash(
  hash: string,
  tabIds: readonly string[],
  aliases: Readonly<Record<string, string>> = {},
): string {
  const raw = hash.startsWith("#") ? hash.slice(1) : hash;
  // Own properties only: "constructor" or "__proto__" in the hash must never resolve through the prototype.
  const mapped = Object.prototype.hasOwnProperty.call(aliases, raw) ? aliases[raw] : raw;
  return tabIds.includes(mapped) ? mapped : tabIds[0];
}

/**
 * Puts `tab` into the URL hash without a history entry and without scrolling to an element of that
 * name. Outside a SvelteKit page context (a mounted component test, a router that is not started
 * yet) it falls back to the History API.
 */
export function writeTabHash(tab: string): void {
  const hash = `#${tab}`;
  try {
    const url = page.url;
    // The href is built from the current `page.url`, whose path already carries any base path;
    // `resolve()` would prefix it a second time (same reasoning as `lib/table/url-state.ts`).
    // eslint-disable-next-line svelte/no-navigation-without-resolve
    replaceState(`${url.pathname}${url.search}${hash}`, page.state ?? {});
  } catch {
    if (typeof history !== "undefined") {
      history.replaceState(history.state, "", `${location.pathname}${location.search}${hash}`);
    }
  }
}

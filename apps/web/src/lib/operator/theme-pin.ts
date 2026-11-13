// Fixed look of the operator console (Issue #89, revised by Issue #842, D-842-21).
//
// The operator has no tenant session and therefore no server-persisted preferences; the shared
// theme store would apply whatever the last tenant user on this device chose. The console pins
// the graphite theme (salz) on <html> by writing the DOM attribute directly - never through the
// stores, which persist to the browser and to `/me/preferences` - and hands back a function that
// puts the replaced attribute back exactly as it was (including "was absent"). The colour mode
// is deliberately not touched: it follows the device.

const PINNED: ReadonlyArray<readonly [string, string]> = [["data-theme", "salz"]];

export function pinOperatorLook(html: HTMLElement): () => void {
  const previous = PINNED.map(([name]) => [name, html.getAttribute(name)] as const);

  for (const [name, value] of PINNED) {
    html.setAttribute(name, value);
  }

  return () => {
    for (const [name, value] of previous) {
      if (value === null) html.removeAttribute(name);
      else html.setAttribute(name, value);
    }
  };
}

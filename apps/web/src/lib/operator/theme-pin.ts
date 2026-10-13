// Fixed look of the operator console (Issue #89, UI-SPEC "Skin, Theme and Mode Decision").
//
// The operator has no tenant session and therefore no server-persisted preferences; the shared
// theme/skin/density stores would apply whatever the last tenant user on this device chose. The
// console pins its look on <html> by writing the DOM attributes directly - never through the
// stores, which persist to the browser and to `/me/preferences` - and hands back a function that
// puts every replaced attribute back exactly as it was (including "was absent"). The colour mode
// is deliberately not touched: it follows the device.

const PINNED: ReadonlyArray<readonly [string, string | null]> = [
  ["data-theme", "nacht"],
  ["data-density", "comfortable"],
  ["data-skin", null], // editorial skin = no attribute
];

export function pinOperatorLook(html: HTMLElement): () => void {
  const previous = PINNED.map(([name]) => [name, html.getAttribute(name)] as const);

  for (const [name, value] of PINNED) {
    if (value === null) html.removeAttribute(name);
    else html.setAttribute(name, value);
  }

  return () => {
    for (const [name, value] of previous) {
      if (value === null) html.removeAttribute(name);
      else html.setAttribute(name, value);
    }
  };
}

/**
 * Issue #621 — keeps the active tab of a horizontally scrolling `.view-tabs` strip in view.
 *
 * The strip scrolls on its own on narrow screens (app.css `.view-tabs`), so a tab chosen by a
 * deep link or by the keyboard (End, ArrowRight past the edge) could otherwise sit outside the
 * visible part of the strip. Used as `use:revealActiveTab={currentTab}` on the strip element by
 * SectionStack and ListDetail, the two places that render the recipe.
 */
export function revealActiveTab(strip: HTMLElement, _activeTab: string | undefined) {
  function reveal() {
    const active = strip.querySelector<HTMLElement>(".view-tab--active");
    if (!active) return;
    // Measured against the strip's own box: offsetLeft would be relative to the nearest positioned
    // ancestor and include the page gutter. Only the strip scrolls; the page never moves
    // (scrollIntoView would also scroll it vertically).
    const tab = active.getBoundingClientRect();
    const box = strip.getBoundingClientRect();
    if (tab.left < box.left) {
      strip.scrollLeft -= box.left - tab.left;
    } else if (tab.right > box.right) {
      strip.scrollLeft += tab.right - box.right;
    }
  }
  reveal();
  return {
    update(_next: string | undefined) {
      // The class moves to the new tab in the same flush; reveal after it has rendered.
      queueMicrotask(reveal);
    },
  };
}

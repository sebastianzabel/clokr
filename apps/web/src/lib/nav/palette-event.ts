/** Issue #844: the window event the header's search button sends to open the quick search (CommandPalette). */
export const OPEN_PALETTE_EVENT = "clokr-open-palette";

export function openPalette(): void {
  window.dispatchEvent(new CustomEvent(OPEN_PALETTE_EVENT));
}

/**
 * Svelte action that traps keyboard focus inside a container (e.g., modals).
 * Usage: <div use:focusTrap>...</div>
 */
export function focusTrap(node: HTMLElement) {
  const focusable =
    'button:not([disabled]), [href], input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';

  function handleKeydown(e: KeyboardEvent) {
    if (e.key !== "Tab") return;
    const elements = Array.from(node.querySelectorAll(focusable)) as HTMLElement[];
    if (elements.length === 0) return;
    const first = elements[0];
    const last = elements[elements.length - 1];

    if (e.shiftKey && document.activeElement === first) {
      e.preventDefault();
      last.focus();
    } else if (!e.shiftKey && document.activeElement === last) {
      e.preventDefault();
      first.focus();
    }
  }

  node.addEventListener("keydown", handleKeydown);
  // Initial focus. Issue #612 — additive: an element carrying `data-autofocus` (and matching the
  // focusable selector, so a disabled one is skipped) wins; every trap without the attribute
  // focuses the first focusable element exactly as before.
  requestAnimationFrame(() => {
    const preferred = Array.from(node.querySelectorAll<HTMLElement>("[data-autofocus]")).find(
      (el) => el.matches(focusable),
    );
    const target = preferred ?? (node.querySelector(focusable) as HTMLElement | null);
    target?.focus();
  });

  return {
    destroy() {
      node.removeEventListener("keydown", handleKeydown);
    },
  };
}

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
  // Auto-focus first focusable element
  requestAnimationFrame(() => {
    const first = node.querySelector(focusable) as HTMLElement;
    first?.focus();
  });

  return {
    destroy() {
      node.removeEventListener("keydown", handleKeydown);
    },
  };
}

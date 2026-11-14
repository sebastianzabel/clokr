<script lang="ts">
  /**
   * Issue #927 — the „…“ menu of one time-entry row on /ich/zeiten. The items are the page's own
   * buttons (passed as children, with their existing test ids), so this component carries no
   * action and no rule: it only opens, positions and closes the list.
   *
   * The list is positioned `fixed` from the trigger's rect, because the DataTable scroll container
   * clips anything absolutely positioned inside it. A click outside, Escape or a click on an item
   * closes it; Escape returns the focus to the trigger.
   */
  import type { Snippet } from "svelte";

  interface Props {
    /** Accessible name of the trigger, e.g. „Aktionen für Fr 6.11.“. */
    label: string;
    /** `data-testid` of the trigger. */
    testId?: string;
    children: Snippet;
  }

  let { label, testId, children }: Props = $props();

  let open = $state(false);
  let trigger: HTMLButtonElement | undefined = $state();
  let list: HTMLDivElement | undefined = $state();
  let pos = $state({ top: 0, left: 0 });
  const MENU_WIDTH = 200;

  function toggle() {
    if (open) {
      open = false;
      return;
    }
    const r = trigger?.getBoundingClientRect();
    if (r) {
      pos = {
        top: r.bottom + 4,
        left: Math.max(8, Math.min(r.right - MENU_WIDTH, window.innerWidth - MENU_WIDTH - 8)),
      };
    }
    open = true;
  }

  // The list leaves the table: an animated card above it carries a `transform`, which would make
  // `position: fixed` relative to that card, and the DataTable scroll container would clip it.
  function portal(node: HTMLElement) {
    document.body.appendChild(node);
    return {
      destroy() {
        node.remove();
      },
    };
  }

  function onWindowPointer(e: PointerEvent) {
    if (!open) return;
    const t = e.target as Node;
    if (trigger?.contains(t) || list?.contains(t)) return;
    open = false;
  }

  function onKey(e: KeyboardEvent) {
    if (open && e.key === "Escape") {
      open = false;
      trigger?.focus();
    }
  }
</script>

<svelte:window
  onpointerdown={onWindowPointer}
  onkeydown={onKey}
  onscroll={() => (open = false)}
  onresize={() => (open = false)}
/>

<button
  type="button"
  class="te-menu-trigger"
  aria-haspopup="true"
  aria-expanded={open}
  aria-label={label}
  data-testid={testId}
  bind:this={trigger}
  onclick={toggle}
>
  <svg width="16" height="16" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
    <circle cx="5" cy="12" r="1.8" /><circle cx="12" cy="12" r="1.8" /><circle
      cx="19"
      cy="12"
      r="1.8"
    />
  </svg>
</button>
{#if open}
  <!-- A click on any item closes the list after the item's own handler ran. -->
  <!-- svelte-ignore a11y_click_events_have_key_events, a11y_no_noninteractive_element_interactions -->
  <div
    class="te-menu-list"
    role="group"
    aria-label={label}
    bind:this={list}
    use:portal
    style:top="{pos.top}px"
    style:left="{pos.left}px"
    style:width="{MENU_WIDTH}px"
    onclick={() => (open = false)}
  >
    {@render children()}
  </div>
{/if}

<style>
  .te-menu-trigger {
    display: inline-grid;
    place-items: center;
    width: var(--h-control-sm, 28px);
    height: var(--h-control-sm, 28px);
    border: 1px solid transparent;
    border-radius: var(--r-control);
    background: transparent;
    color: var(--text-2);
    cursor: pointer;
  }
  .te-menu-trigger:hover,
  .te-menu-trigger[aria-expanded="true"] {
    background: var(--hover);
    color: var(--text);
  }
  .te-menu-trigger:focus-visible {
    outline: 2px solid var(--brand);
    outline-offset: 2px;
  }
  .te-menu-list {
    position: fixed;
    z-index: 80;
    display: flex;
    flex-direction: column;
    padding: 4px;
    background: var(--card);
    border: 1px solid var(--line);
    border-radius: var(--r-control);
    box-shadow: var(--shadow-pop);
  }
  /* The items are the page's buttons; the menu only gives them one shape. */
  .te-menu-list :global(button) {
    display: flex;
    align-items: center;
    width: 100%;
    min-height: 34px;
    padding: 0 10px;
    border: 0;
    border-radius: 6px;
    background: transparent;
    color: var(--text);
    font: inherit;
    font-size: var(--fs-base);
    text-align: left;
    cursor: pointer;
  }
  .te-menu-list :global(button:hover:not(:disabled)) {
    background: var(--hover);
  }
  .te-menu-list :global(button:disabled) {
    color: var(--text-3);
    cursor: not-allowed;
  }
  .te-menu-list :global(button.te-menu-danger) {
    color: var(--bad);
  }
</style>

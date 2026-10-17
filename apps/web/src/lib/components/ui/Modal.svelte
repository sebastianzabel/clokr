<script lang="ts">
  import type { Snippet } from "svelte";
  import { focusTrap } from "$lib/utils/focus-trap";

  interface Props {
    /** Two-way bindable open state. Parent holds `let modalOpen = $state(false)`. */
    open: boolean;
    /** Optional serif italic eyebrow rendered above the title. */
    eyebrow?: string;
    /** Main heading rendered as serif H3 inside the modal header. */
    title: string;
    /** Overrides title for aria-label. Defaults to title. */
    ariaLabel?: string;
    /** Body content. */
    children: Snippet;
    /** Optional footer snippet (e.g. button row). */
    footer?: Snippet;
    /**
     * Issue #612 — additive. "md" (default) is the global `.modal` width; "wide" adds
     * `modal--wide` (880 px, capped to the viewport) for the person drill-down.
     */
    size?: "md" | "wide";
  }

  let {
    open = $bindable(),
    eyebrow,
    title,
    ariaLabel,
    children,
    footer,
    size = "md",
  }: Props = $props();

  // Bound to the .scrim element so the inert effect can exclude it by reference.
  let scrimEl: HTMLDivElement | undefined = $state();

  function onKeyDown(e: KeyboardEvent) {
    if (e.key === "Escape" && open) {
      e.preventDefault();
      open = false;
    }
  }

  function onBackdropClick(e: MouseEvent) {
    if (e.target === e.currentTarget) open = false;
  }

  // Lock body scroll + mark background siblings inert while open; restore on close/unmount.
  $effect(() => {
    if (!open || !scrimEl) return;
    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";

    // Apply `inert` to every top-level body child that does NOT contain the
    // .scrim element. We exclude by reference (el.contains(scrimEl)) rather
    // than by class name because the .scrim is never a direct body child —
    // SvelteKit wraps the entire app in a <div style="display:contents"> and
    // the modal renders inline inside the page tree, not teleported to <body>.
    const toRestore: Element[] = [];
    for (const child of Array.from(document.body.children)) {
      if (child.contains(scrimEl)) continue;
      if (child.hasAttribute("inert")) continue;
      child.setAttribute("inert", "");
      toRestore.push(child);
    }

    return () => {
      document.body.style.overflow = previousOverflow;
      for (const el of toRestore) el.removeAttribute("inert");
    };
  });
</script>

<svelte:window onkeydown={onKeyDown} />

{#if open}
  <div class="scrim" role="presentation" onclick={onBackdropClick} bind:this={scrimEl}>
    <div
      class="modal"
      class:modal--wide={size === "wide"}
      role="dialog"
      aria-modal="true"
      aria-label={ariaLabel ?? title}
      use:focusTrap
    >
      <header class="modal-hd">
        <div>
          {#if eyebrow}<div class="modal-eyebrow">{eyebrow}</div>{/if}
          <h3>{title}</h3>
        </div>
      </header>
      <div class="modal-body">
        {@render children()}
      </div>
      {#if footer}
        <footer class="modal-foot">
          {@render footer()}
        </footer>
      {/if}
    </div>
  </div>
{/if}

<style>
  /* Issue #612: the scoped selector (the component hash class makes it 0,2,0) outranks the
     global `.modal` width recipe. */
  .modal--wide {
    width: min(880px, calc(100vw - 32px));
  }

  .modal-eyebrow {
    font-family: var(--font-serif);
    font-style: italic;
    color: var(--brand-light, var(--brand));
    font-size: 13px;
    line-height: 1;
    margin-bottom: 4px;
  }
</style>

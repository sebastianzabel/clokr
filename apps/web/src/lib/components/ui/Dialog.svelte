<script lang="ts">
  // Issue #843 (D-843-01 block 11, D-843-16) - the ONE overlay implementation: a bits-ui Dialog
  // portaled into <body>, with the legacy class names kept (`scrim`, `modal`, `modal-hd`,
  // `modal-body`, `modal-foot`, `modal-eyebrow`, `modal--wide`) so existing selectors, tests and
  // the app.css recipes keep working.
  //
  // `static` renders only the panel (no portal, no overlay, no focus trap, no Escape layer). It
  // exists for DialogPanel, the example page's themed frames: a portaled overlay would leave the
  // frame's data-theme/data-mode, so the frames show the panel in place. The panel markup lives
  // here once, for both modes.
  import type { Snippet } from "svelte";
  import { Dialog } from "bits-ui";

  interface Props {
    /** Two-way bindable open state. Ignored in `static` mode (the panel is always shown). */
    open?: boolean;
    /** Main heading, rendered as an h3 inside the header. */
    title: string;
    /** Optional eyebrow above the title. */
    eyebrow?: string;
    /** Overrides the title as the dialog's accessible name. */
    ariaLabel?: string;
    /** "md" is the 520 px dialog, "wide" the 880 px drill-down size. */
    size?: "md" | "wide";
    /** Body content. */
    children: Snippet;
    /** Footer content, right-aligned: secondary action first, primary last. */
    footer?: Snippet;
    /** Called after the open state changed (user-driven or through the binding). */
    onOpenChange?: (open: boolean) => void;
    /** Render the bare panel in place (used by DialogPanel only). */
    static?: boolean;
  }

  let {
    open = $bindable(false),
    title,
    eyebrow,
    ariaLabel,
    size = "md",
    children,
    footer,
    onOpenChange,
    static: staticPanel = false,
  }: Props = $props();

  let contentEl: HTMLElement | null = $state(null);
  let overlayEl: HTMLElement | null = $state(null);

  /** One path for every change, so `onOpenChange` fires for the overlay click as well. */
  function setOpen(next: boolean) {
    open = next;
    onOpenChange?.(next);
  }

  /** The overlay closes the dialog only for a click that landed on the overlay itself. */
  function onScrimClick(e: MouseEvent) {
    if (e.target === e.currentTarget) setOpen(false);
  }

  // D-843-16 (#636): bits-ui sets aria-modal but makes nothing inert. While open, every direct child
  // of <body> that is neither the dialog content, nor this dialog's own overlay, nor a toast region
  // gets `inert`. bits-ui portals the overlay and the content as two separate children of <body>,
  // and an inert overlay receives no pointer events, so inerting it would leave the page behind
  // clickable. The effect remembers exactly the nodes it changed and restores them on close and on
  // destroy; a node that is inert already (page state before opening, or an outer dialog's work
  // for a nested one) is left alone.
  //
  // The restore also runs from `onCloseAutoFocus` (below): bits-ui's focus scope returns the focus
  // to the opener while it is torn down, and that happens BEFORE this effect's cleanup runs. A
  // still-inert opener cannot take the focus, so the cleanup alone left the focus on <body>.
  let releaseInert: (() => void) | null = null;

  $effect(() => {
    if (staticPanel || !open || !contentEl) return;
    const content = contentEl;
    const overlay = overlayEl;
    const changed: Element[] = [];
    for (const child of Array.from(document.body.children)) {
      if (child.contains(content) || (overlay && child.contains(overlay))) continue;
      if (child.matches("[data-toast-root]")) continue;
      if (child.hasAttribute("inert")) continue;
      child.setAttribute("inert", "");
      changed.push(child);
    }
    const release = () => {
      for (const el of changed.splice(0)) el.removeAttribute("inert");
      if (releaseInert === release) releaseInert = null;
    };
    releaseInert = release;
    return release;
  });

  /** Make the page focusable again before bits-ui returns the focus to the opener. */
  function onCloseAutoFocus() {
    releaseInert?.();
  }

  /** Focus the first [data-autofocus] element instead of bits-ui's first tabbable. */
  function onOpenAutoFocus(e: Event) {
    const target = contentEl?.querySelector<HTMLElement>("[data-autofocus]");
    if (!target) return;
    e.preventDefault();
    target.focus();
  }
</script>

{#snippet panel(live: boolean)}
  <header class="modal-hd">
    <div>
      {#if eyebrow}<div class="modal-eyebrow">{eyebrow}</div>{/if}
      {#if live}
        <Dialog.Title level={3}>
          {#snippet child({ props })}
            <h3 {...props}>{title}</h3>
          {/snippet}
        </Dialog.Title>
      {:else}
        <h3>{title}</h3>
      {/if}
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
{/snippet}

{#if staticPanel}
  <div class="modal modal--static" class:modal--wide={size === "wide"} aria-label={title}>
    {@render panel(false)}
  </div>
{:else}
  <!-- Controlled both ways: bits-ui reads `open` and writes through setOpen only. A parent whose
         binding refuses a closing (ConfirmDialog while a confirm is pending) therefore keeps the
         dialog open, instead of bits-ui holding a private closed state next to an open prop. -->
  <Dialog.Root bind:open={() => open, setOpen}>
    <!-- Unmounted together with the state, not after bits-ui's presence delay (two animation
         frames): a closed dialog leaves no DOM behind in the same flush, as the old Modal did, and
         no exit animation exists. Mounted open, so bits-ui's presence starts present. -->
    {#if open}
      <Dialog.Portal>
        <Dialog.Overlay bind:ref={overlayEl}>
          {#snippet child({ props })}
            <div {...props} class="scrim" role="presentation" onclick={onScrimClick}></div>
          {/snippet}
        </Dialog.Overlay>
        <Dialog.Content
          bind:ref={contentEl}
          interactOutsideBehavior="ignore"
          {onOpenAutoFocus}
          {onCloseAutoFocus}
        >
          {#snippet child({ props })}
            <!-- The accessible name is the aria-label (legacy contract); bits-ui's labelledby and
                 describedby are dropped because there is no description element to point at. -->
            <div
              {...props}
              class="modal"
              class:modal--wide={size === "wide"}
              aria-label={ariaLabel ?? title}
              aria-labelledby={undefined}
              aria-describedby={undefined}
            >
              {@render panel(true)}
            </div>
          {/snippet}
        </Dialog.Content>
      </Dialog.Portal>
    {/if}
  </Dialog.Root>
{/if}

<style>
  /* The z-scale of the app, written once (D-843-16, #636). The topbar is sticky at 1000 and used
     to paint over the old overlay (200); the dialog now covers it, and the toast still covers the
     dialog:
       sidebar 100 - mobile bottom bar 90 - mobile sheet 500 - topbar 1000 - skip link 1000
       dialog overlay 1500 - dialog content 1501 - What's-New 2000 - command palette 9000
       toast 9999 */
  .scrim {
    position: fixed;
    inset: 0;
    z-index: 1500;
  }

  /* The content is a sibling of the overlay inside the portal, so it centres itself: inset 0 plus
     margin auto and a fit-content height, never a transform (#570: a transform would make the
     element the containing block of any fixed descendant). */
  .modal {
    position: fixed;
    inset: 0;
    margin: auto;
    height: fit-content;
    z-index: 1501;
    width: min(520px, calc(100vw - 32px));
    max-height: calc(100vh - 64px);
  }

  /* The drill-down size (#612), capped to the viewport. */
  .modal--wide {
    width: min(880px, calc(100vw - 32px));
  }

  /* The wide dialog carries the drill-down's footer buttons ("Schließen", "DATEV für diese Person",
     "Stundennachweis (PDF)"): in one row they end beyond a phone and the dialog clips them (found
     by the 390/360 px matrix of reports-period.spec.ts). They wrap instead; a footer that fits
     renders exactly as before. */
  .modal--wide .modal-foot {
    flex-wrap: wrap;
  }

  .modal--static {
    position: static;
    inset: auto;
    margin: 0;
    z-index: auto;
    width: min(520px, 100%);
    max-height: none;
  }

  .modal--static.modal--wide {
    width: min(880px, 100%);
  }

  .modal-eyebrow {
    font-family: var(--font-ui);
    color: var(--brand);
    font-size: 13px;
    line-height: 1;
    margin-bottom: 4px;
  }

  /* Below a 760 px viewport the dialog is a bottom sheet (D-843-03: the one viewport query of the
     blocks besides reduced motion): full width, anchored to the bottom edge, rounded on top,
     scrolling inside itself, footer buttons stacked at full width. The static panel of the example
     frames stays a panel. */
  @media (max-width: 759.98px) {
    .modal {
      inset: auto 0 0 0;
      width: 100%;
      margin: 0;
      max-height: 85vh;
      border-radius: var(--r-card) var(--r-card) 0 0;
      overflow-y: auto;
    }

    .modal--static {
      inset: auto;
      max-height: none;
      border-radius: var(--r-card);
      overflow-y: visible;
    }

    .modal .modal-foot {
      flex-direction: column;
      align-items: stretch;
    }

    .modal-foot :global(.btn) {
      width: 100%;
    }
  }
</style>

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

  /** One path for every change, so `onOpenChange` fires for the overlay click as well. */
  function setOpen(next: boolean) {
    open = next;
    onOpenChange?.(next);
  }

  /** The overlay closes the dialog only for a click that landed on the overlay itself. */
  function onScrimClick(e: MouseEvent) {
    if (e.target === e.currentTarget) setOpen(false);
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
  <Dialog.Root {open} onOpenChange={setOpen}>
    <Dialog.Portal>
      <Dialog.Overlay>
        {#snippet child({ props })}
          <div {...props} class="scrim" role="presentation" onclick={onScrimClick}></div>
        {/snippet}
      </Dialog.Overlay>
      <Dialog.Content bind:ref={contentEl} interactOutsideBehavior="ignore" {onOpenAutoFocus}>
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
  </Dialog.Root>
{/if}

<style>
  /* The content is a sibling of the overlay inside the portal, so it centres itself: inset 0 plus
     margin auto and a fit-content height, never a transform (#570: a transform would make the
     element the containing block of any fixed descendant). */
  .modal {
    position: fixed;
    inset: 0;
    margin: auto;
    height: fit-content;
    z-index: 201;
    width: min(520px, calc(100vw - 32px));
    max-height: calc(100vh - 64px);
  }

  /* The drill-down size (#612), capped to the viewport. */
  .modal--wide {
    width: min(880px, calc(100vw - 32px));
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
</style>

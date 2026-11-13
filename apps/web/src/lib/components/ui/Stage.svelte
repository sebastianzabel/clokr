<script lang="ts">
  // Issue #843 (D-843-01 block 4) - the Bühne: the one large surface of a page that shows what the
  // person is doing right now (clock state, a running task). Its four states differ by surface
  // only, and the surface changes with a STATE_MS (350 ms) background transition:
  //   ruhig -> card, arbeitet -> brand-soft, pause -> warn-soft, fertig -> card.
  // Text: --text on card and brand-soft (both proven pairs in token-contrast-842). On warn-soft
  // the proven text colour is --warn itself (the contrast test lists warn on warn-soft, not
  // text on warn-soft), so the pause state uses it.
  import type { Snippet } from "svelte";

  export type StageState = "ruhig" | "arbeitet" | "pause" | "fertig";

  interface Props {
    state: StageState;
    children: Snippet;
    /** Buttons of the stage (clock in, pause, ...); each is at least --h-stage high. */
    actions?: Snippet;
    /** Names the stage for assistive technology (e.g. "Zeiterfassung"). */
    ariaLabel?: string;
  }

  let { state, children, actions, ariaLabel }: Props = $props();
</script>

<div class="stage" data-state={state} role={ariaLabel ? "group" : undefined} aria-label={ariaLabel}>
  <div class="stage-body">{@render children()}</div>
  {#if actions}<div class="stage-actions">{@render actions()}</div>{/if}
</div>

<style>
  .stage {
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    justify-content: space-between;
    gap: var(--s-3) var(--s-5);
    padding: var(--s-4) var(--s-5);
    background: var(--card);
    border: 1px solid var(--line);
    border-radius: var(--r-stage);
    color: var(--text);
    font-size: var(--fs-base);
    transition: background-color 350ms var(--ease-out);
  }
  .stage[data-state="arbeitet"] {
    background: var(--brand-soft);
  }
  .stage[data-state="pause"] {
    background: var(--warn-soft);
    color: var(--warn);
  }

  .stage-body {
    min-width: 0;
    flex: 1 1 auto;
  }
  .stage-actions {
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    gap: var(--s-2);
  }
  /* Whatever button the page puts in the actions row, it is stage-high. */
  .stage-actions :global(button),
  .stage-actions :global(a) {
    min-height: var(--h-stage);
  }

  @media (prefers-reduced-motion: reduce) {
    .stage {
      transition: none;
    }
  }
</style>

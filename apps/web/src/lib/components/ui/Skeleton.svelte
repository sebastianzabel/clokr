<script lang="ts" module>
  export type SkeletonShape = "line" | "block" | "row" | "card";
</script>

<script lang="ts">
  // Issue #843 (D-843-01 block 10, D-843-07) - the one loading state. The region announces itself once
  // (role=status, aria-busy, aria-label) and holds exactly one visually hidden „Wird geladen“; the
  // shapes are decoration. There is deliberately no prop for the text: this file is the only source of
  // loading wording (a source scan keeps visible loading text out of routes and lib).
  interface Props {
    shape?: SkeletonShape;
    /** How many shapes to render (rows of a list, lines of a text). */
    count?: number;
    /** Text lines inside a card shape. */
    lines?: number;
    /** Height of a block shape (any CSS length). */
    height?: string;
    /** Inline variant: a span with one bar inside a sentence or label. */
    inline?: boolean;
    /** Width of the inline bar in em. */
    width?: number;
  }

  let { shape = "line", count = 1, lines = 2, height, inline = false, width = 6 }: Props = $props();

  const items = $derived(Array.from({ length: Math.max(1, Math.floor(count)) }, (_, i) => i));
  const cardLines = $derived(Array.from({ length: Math.max(1, Math.floor(lines)) }, (_, i) => i));
</script>

{#if inline}
  <span
    class="skeleton-region skeleton-region--inline"
    role="status"
    aria-busy="true"
    aria-label="Wird geladen"
  >
    <span class="skeleton skeleton-inline" style="width: {width}em" aria-hidden="true"></span>
    <span class="sr-only">Wird geladen</span>
  </span>
{:else}
  <div class="skeleton-region" role="status" aria-busy="true" aria-label="Wird geladen">
    {#each items as i (i)}
      {#if shape === "row"}
        <div class="skeleton-row" aria-hidden="true">
          <span class="skeleton skeleton-avatar"></span>
          <span class="skeleton-row-bars">
            <span class="skeleton skeleton-text skeleton-bar-long"></span>
            <span class="skeleton skeleton-text skeleton-bar-short"></span>
          </span>
        </div>
      {:else if shape === "card"}
        <div class="skeleton-card" aria-hidden="true">
          <span class="skeleton skeleton-heading"></span>
          {#each cardLines as l (l)}
            <span class="skeleton skeleton-text"></span>
          {/each}
        </div>
      {:else if shape === "block"}
        <span
          class="skeleton skeleton-block"
          style={height ? `--skeleton-block-h: ${height}` : undefined}
          aria-hidden="true"
        ></span>
      {:else}
        <span class="skeleton skeleton-text skeleton-line" aria-hidden="true"></span>
      {/if}
    {/each}
    <span class="sr-only">Wird geladen</span>
  </div>
{/if}

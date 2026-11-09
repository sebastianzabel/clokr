<script lang="ts">
  // Issue #843 (D-843-01 block 5) - the list: a labelled `ul` of ListRow items (44 px rows).
  import type { Snippet } from "svelte";

  interface Props {
    /** Accessible name of the list. */
    ariaLabel: string;
    children: Snippet;
  }

  let { ariaLabel, children }: Props = $props();
</script>

<ul class="ui-list" aria-label={ariaLabel}>
  {@render children()}
</ul>

<style>
  .ui-list {
    list-style: none;
    margin: 0;
    padding: 0;
    background: var(--card);
    border: 1px solid var(--line);
    border-radius: var(--r-card);
    overflow: hidden;
  }
</style>

<script lang="ts">
  // Issue #853 (D-853-18) - the section of the prototype (`.sec`): a heading line with an optional
  // right-hand act text or link, separated from the previous section by a top rule. No card surface -
  // the Team pages are built from plain sections, lists and tables, not from stacks of cards.
  // `title` is rendered as text; the `action` snippet is the caller's own link or text.
  import type { Snippet } from "svelte";

  interface Props {
    /** German heading of the section. */
    title: string;
    /** Right-hand act of the heading line, e.g. „Alle ansehen →“ (a link or plain text). */
    action?: Snippet;
    children: Snippet;
    /** Level of the heading; 2 for a section of the page, 3 for one inside another section. */
    headingLevel?: 2 | 3;
  }

  let { title, action, children, headingLevel = 2 }: Props = $props();
</script>

<section class="team-section">
  <svelte:element this={`h${headingLevel}`} class="team-section-head">
    <span class="team-section-title">{title}</span>
    {#if action}
      <span class="team-section-act">{@render action()}</span>
    {/if}
  </svelte:element>
  {@render children()}
</section>

<style>
  .team-section {
    padding: 14px 0;
    border-top: 1px solid var(--line);
  }

  .team-section:first-child {
    padding-top: 0;
    border-top: 0;
  }

  .team-section-head {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 10px;
    margin: 0 0 10px;
    font-family: var(--font-ui);
    font-size: var(--fs-h2);
    font-weight: 600;
    line-height: 1.3;
    color: var(--text);
  }

  .team-section-title {
    min-width: 0;
    overflow-wrap: anywhere;
  }

  .team-section-act {
    flex: none;
    font-size: var(--fs-sm);
    font-weight: 500;
    color: var(--text-2);
  }

  .team-section-act :global(a) {
    color: inherit;
  }

  .team-section-act :global(a:hover) {
    color: var(--text);
  }
</style>

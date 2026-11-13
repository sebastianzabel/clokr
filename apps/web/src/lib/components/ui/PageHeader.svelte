<script lang="ts">
  // Issue #843 (D-843-01 block 1, D-843-14, D-843-22) - the ONE Seitenkopf implementation. The legacy
  // layout/PageHead.svelte delegates here without markup of its own. Per the design concept (3/4) the
  // head is title + subtitle on the left and one or two actions on the right (below the text on a
  // phone): no accent rule, no eyebrow line, no colour-set accent word (owner request 10.11.).
  // `eyebrow` and `accent` stay in the props so every PageHead caller compiles unchanged, but they
  // are inert - nothing renders them. With tabs a bits-ui tab strip follows the head; with
  // `tabsLook="segments"` the tabs are a segmented control on the RIGHT of the head instead (the
  // detail head of the prototype, Issue #854), and `leading` puts an avatar before the title.
  import type { Snippet } from "svelte";
  import PageTabs from "./PageTabs.svelte";

  interface PageTab {
    value: string;
    label: string;
  }

  interface Props {
    /** Main heading, e.g. "Guten Tag, Lena". */
    title: string;
    /** Optional muted sub-paragraph, max-width 560 px, below the heading. */
    subtitle?: string;
    /** Inert (D-843-22): accepted so PageHead callers keep compiling, never rendered. */
    eyebrow?: string;
    /** Inert (D-843-22): accepted so PageHead callers keep compiling; the title is plain text. */
    accent?: string;
    /** Right-aligned action cluster: one or two buttons, at most one primary. */
    actions?: Snippet;
    /** Page tabs; each trigger controls a rendered panel. */
    tabs?: PageTab[];
    /** Selected tab value (bindable); the first tab while nothing is bound. */
    tab?: string;
    /** Renders the panel of one tab; receives the tab value. */
    panel?: Snippet<[string]>;
    /** Called after the tab selection changed. */
    onTabChange?: (value: string) => void;
    /** Level of the title element; 2 for a header inside a page that has its own h1. */
    headingLevel?: 1 | 2;
    /** "strip" (default): tabs below the head; "segments": a segmented control right of the head. */
    tabsLook?: "strip" | "segments";
    /** Accessible name of the tablist. */
    tabsLabel?: string;
    /** Rendered before the title block (an avatar) with `tabsLook="segments"`; decorative only. */
    leading?: Snippet;
  }

  let {
    title,
    subtitle,
    actions,
    tabs,
    tab = $bindable(),
    panel,
    onTabChange,
    headingLevel = 1,
    tabsLook = "strip",
    tabsLabel,
    leading,
  }: Props = $props();
</script>

{#snippet head(withTabs: boolean)}
  <header
    class="page-head"
    class:page-head--tabs={withTabs}
    class:page-head--inline={withTabs && tabsLook === "segments"}
  >
    <div class="page-head-text">
      {#if headingLevel === 2}
        <h2 translate="no">{title}</h2>
      {:else}
        <h1 translate="no">{title}</h1>
      {/if}
      {#if subtitle}
        <p class="sub">{subtitle}</p>
      {/if}
    </div>
    {#if actions}
      <div class="page-head-actions">
        {@render actions()}
      </div>
    {/if}
  </header>
{/snippet}

<!-- The head is a snippet so that both branches render exactly one <header> and nothing else. -->
<!-- The leading (an avatar) sits next to the header, never inside it, so the header's markup is the
     same with and without one. -->
{#snippet segmentsHead()}
  {#if leading}
    <div class="page-head-row">
      <div class="page-head-leading">{@render leading()}</div>
      {@render head(true)}
    </div>
  {:else}
    {@render head(true)}
  {/if}
{/snippet}

{#if tabs && tabs.length > 0 && tabsLook === "segments"}
  <PageTabs {tabs} bind:tab {panel} {onTabChange} {tabsLabel} look="segments" head={segmentsHead} />
{:else if tabs && tabs.length > 0}
  {@render head(true)}
  <PageTabs {tabs} bind:tab {panel} {onTabChange} {tabsLabel} />
{:else}
  {@render head(false)}
{/if}

<style>
  /* The root is the container: below 760 px of its own width the actions sit under the title. */
  .page-head {
    container-type: inline-size;
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 24px;
    margin-bottom: 24px;
    flex-wrap: wrap;
  }

  .page-head--tabs {
    margin-bottom: 8px;
  }

  .page-head-text {
    flex: 1;
    min-width: 0;
  }

  /* Inside the segments row the row itself keeps the distance to the panel. */
  .page-head--inline {
    margin-bottom: 0;
    flex-wrap: nowrap;
    gap: var(--s-3);
  }

  .page-head-row {
    display: flex;
    align-items: center;
    gap: var(--s-3);
    min-width: 0;
  }

  .page-head-row > .page-head {
    flex: 1;
    min-width: 0;
  }

  .page-head-leading {
    flex: none;
    display: inline-flex;
    align-items: center;
  }

  .page-head :is(h1, h2) {
    font-family: var(--font-ui);
    font-weight: 600;
    font-size: var(--fs-h1);
    line-height: 1.25;
    margin: 0;
    color: var(--text);
    /* A page title that is a user-entered name (a 200-character tenant name) wraps, it never widens the page. */
    overflow-wrap: anywhere;
  }

  .page-head .sub {
    margin: 4px 0 0;
    max-width: 560px;
    color: var(--text-2);
    font-size: var(--fs-base);
    line-height: 1.55;
    overflow-wrap: anywhere;
  }

  .page-head-actions {
    display: flex;
    gap: 8px;
    align-items: center;
    flex-shrink: 0;
  }

  /* A container query styles the container's children only, so the narrow layout is expressed on
     the two children: the text takes the whole row and the actions wrap below it. */
  @container (max-width: 759.98px) {
    .page-head-text {
      flex: 1 1 100%;
    }
    .page-head-actions {
      width: 100%;
      justify-content: flex-start;
      /* Two actions may be wider than a 320 px phone together; the second one then takes a row. */
      flex-wrap: wrap;
    }
  }
</style>

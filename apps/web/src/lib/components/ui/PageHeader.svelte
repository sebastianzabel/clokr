<script lang="ts">
  // Issue #843 (D-843-01 block 1, D-843-14) - the ONE Seitenkopf implementation. The legacy
  // layout/PageHead.svelte delegates here without markup of its own, so its DOM (classes, element
  // order, text) is the DOM of this block. Without tabs the root is the same <header class="page-head">
  // PageHead always rendered; with tabs a bits-ui tab strip follows the head.
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
    /** Legacy eyebrow line above the title (PageHead keeps passing it, D-843-14). */
    eyebrow?: string;
    /**
     * Optional explicit accent word. When omitted, the autoAccent rule applies: the last token
     * after the final `-` or whitespace separator is set apart in --brand; single-word titles
     * render plain. When given AND found in `title`, its first occurrence is wrapped in `<em>`
     * (case-sensitive). The split is element text only, never HTML (threat T-27-01 / T-843-03).
     */
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
  }

  let {
    title,
    subtitle,
    eyebrow,
    accent,
    actions,
    tabs,
    tab = $bindable(),
    panel,
    onTabChange,
    headingLevel = 1,
  }: Props = $props();

  // Derive a [pre, match, post] split for the heading.
  //
  // 1. Explicit `accent` (case-sensitive substring match): first occurrence wrapped.
  //    If accent is given but not found in title -> render plain.
  // 2. autoAccent (no `accent` prop): split on the LAST `-` or whitespace separator and set the
  //    trailing token apart. Single-word titles render plain (no `<em>` wrapper).
  //
  // Both branches output element text only - never `{@html}` - so prop values remain escaped.
  const titleParts = $derived.by(() => {
    if (accent) {
      const idx = title.indexOf(accent);
      if (idx === -1) return { pre: title, match: "", post: "" };
      return {
        pre: title.slice(0, idx),
        match: accent,
        post: title.slice(idx + accent.length),
      };
    }
    const matches = [...title.matchAll(/[\s-]/g)];
    if (matches.length === 0) return { pre: title, match: "", post: "" };
    const last = matches[matches.length - 1];
    const splitIdx = (last.index ?? 0) + 1;
    return {
      pre: title.slice(0, splitIdx),
      match: title.slice(splitIdx),
      post: "",
    };
  });
</script>

{#snippet titleText()}
  {#if titleParts.match}
    {titleParts.pre}<em>{titleParts.match}</em>{titleParts.post}
  {:else}
    {title}
  {/if}
{/snippet}

{#snippet head(withTabs: boolean)}
  <header class="page-head" class:page-head--tabs={withTabs}>
    <div class="page-head-text">
      <div class="brand-rule" aria-hidden="true"></div>
      {#if eyebrow}
        <div class="eyebrow" translate="no">{eyebrow}</div>
      {/if}
      {#if headingLevel === 2}
        <h2 translate="no">{@render titleText()}</h2>
      {:else}
        <h1 translate="no">{@render titleText()}</h1>
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

<!-- The head is a snippet so that both branches render exactly one <header> and nothing else
     (a stray text node after the header would be a DOM difference to the legacy PageHead). -->
{#if tabs && tabs.length > 0}
  {@render head(true)}
  <PageTabs {tabs} bind:tab {panel} {onTabChange} />
{:else}
  {@render head(false)}
{/if}

<style>
  /* The root is the container: below 760 px of its own width the actions sit under the title. */
  .page-head {
    container-type: inline-size;
    display: flex;
    align-items: flex-end;
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

  .brand-rule {
    width: 42px;
    height: 2px;
    background: var(--brand);
    margin-bottom: 14px;
    border-radius: 1px;
  }

  .eyebrow {
    font-family: var(--font-ui);
    font-size: 14px;
    color: var(--brand);
    letter-spacing: 0.02em;
    margin-bottom: 4px;
  }

  .page-head :is(h1, h2) {
    font-family: var(--font-ui);
    font-weight: 400;
    font-size: clamp(28px, 3.4vw, 40px);
    line-height: 1.05;
    margin: 0;
    letter-spacing: 0.005em;
    color: var(--text);
    /* A page title that is a user-entered name (a 200-character tenant name) wraps, it never widens the page. */
    overflow-wrap: anywhere;
  }

  .page-head :is(h1, h2) :global(em) {
    font-style: normal;
    color: var(--brand);
  }

  .page-head .sub {
    margin: 10px 0 0;
    max-width: 560px;
    color: var(--text-2);
    font-size: 14px;
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
    }
  }
</style>

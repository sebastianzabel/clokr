<script lang="ts">
  // Issue #843 (D-843-01 block 1) - the page tabs of the Seitenkopf, a private sub-part of
  // PageHeader. bits-ui Tabs gives the roving focus (ArrowLeft/ArrowRight, looping), the automatic
  // activation and the aria-controls link from every trigger to its panel; every panel stays in
  // the DOM (hidden while inactive), so aria-controls never points at nothing.
  //
  // Each bits-ui part renders through its `child` snippet, so the elements are this component's
  // own and the scoped CSS below applies to them.
  //
  // Issue #854 (owner review of the Personen detail): `look="segments"` draws the same tablist as a
  // segmented control and, with `head`, places it on the RIGHT of a head row (the prototype's detail
  // head: avatar, name, sub line, segments). The semantics, the roving focus and the panels are the
  // same as the strip's; below 640 px of the row's width the segments wrap under the head and scroll
  // inside their own box, never widening the page.
  import type { Snippet } from "svelte";
  import { Tabs } from "bits-ui";

  interface PageTab {
    /** Control value of the tab, never shown. */
    value: string;
    /** German label of the trigger. */
    label: string;
  }

  interface Props {
    tabs: PageTab[];
    /** Selected tab value; the first tab while nothing is bound. */
    tab?: string;
    /** Renders the panel of one tab; receives the tab value. */
    panel?: Snippet<[string]>;
    /** Called after the selection changed. */
    onTabChange?: (value: string) => void;
    /** Accessible name of the tab strip. */
    tabsLabel?: string;
    /** "strip" (default): underlined tabs below the head; "segments": a segmented control. */
    look?: "strip" | "segments";
    /** Rendered in one row BEFORE the tablist (the segments sit on its right). */
    head?: Snippet;
  }

  let {
    tabs,
    tab = $bindable(),
    panel,
    onTabChange,
    tabsLabel = "Bereiche",
    look = "strip",
    head,
  }: Props = $props();

  const current = $derived(tab ?? tabs[0]?.value ?? "");

  function select(next: string) {
    tab = next;
    onTabChange?.(next);
  }
</script>

{#snippet list()}
  <Tabs.List aria-label={tabsLabel}>
    {#snippet child({ props: listProps })}
      <div {...listProps} class="page-tab-strip">
        {#each tabs as item (item.value)}
          <Tabs.Trigger value={item.value}>
            {#snippet child({ props: triggerProps })}
              <button {...triggerProps} class="page-tab">{item.label}</button>
            {/snippet}
          </Tabs.Trigger>
        {/each}
      </div>
    {/snippet}
  </Tabs.List>
{/snippet}

<Tabs.Root value={current} onValueChange={select} loop activationMode="automatic">
  {#snippet child({ props })}
    <div {...props} class="page-tabs" class:page-tabs--segments={look === "segments"}>
      {#if head}
        <div class="page-tabs-head">
          <div class="page-tabs-lead">{@render head()}</div>
          {@render list()}
        </div>
      {:else}
        {@render list()}
      {/if}
      {#each tabs as item (item.value)}
        <Tabs.Content value={item.value}>
          {#snippet child({ props: contentProps })}
            <div {...contentProps} class="page-tab-panel">
              {@render panel?.(item.value)}
            </div>
          {/snippet}
        </Tabs.Content>
      {/each}
    </div>
  {/snippet}
</Tabs.Root>

<style>
  .page-tabs {
    min-width: 0;
  }

  /* The strip scrolls inside itself at narrow widths instead of widening the page. The baseline is
     an inset shadow, not a border: with overflow-x: auto the strip clips its content box. */
  .page-tab-strip {
    display: flex;
    gap: 4px;
    margin-bottom: 16px;
    box-shadow: inset 0 -2px 0 var(--line);
    overflow-x: auto;
    overflow-y: hidden;
    overscroll-behavior-x: contain;
    scrollbar-width: none;
  }

  .page-tab-strip::-webkit-scrollbar {
    display: none;
  }

  .page-tab {
    flex: 0 0 auto;
    white-space: nowrap;
    min-height: var(--h-row);
    padding: 0 18px;
    background: none;
    border: none;
    border-bottom: 2px solid transparent;
    border-radius: 4px 4px 0 0;
    cursor: pointer;
    font-family: var(--font-ui);
    font-size: var(--fs-base);
    font-weight: 500;
    color: var(--text-2);
  }

  .page-tab:hover {
    color: var(--text);
  }

  .page-tab[data-state="active"] {
    color: var(--brand);
    border-bottom-color: var(--brand);
    font-weight: 600;
  }

  /* Inset ring: the strip clips an outside outline. */
  .page-tab:focus-visible {
    outline: 2px solid var(--brand);
    outline-offset: -2px;
  }

  /* ── look="segments" ─────────────────────────────────────────────────────── */

  /* The head row is the container: the lead takes the free width, the segments keep their own. */
  .page-tabs-head {
    container-type: inline-size;
    display: flex;
    align-items: flex-end;
    justify-content: space-between;
    flex-wrap: wrap;
    gap: var(--s-3) var(--s-6);
    margin-bottom: var(--s-6);
  }

  .page-tabs-lead {
    flex: 1 1 auto;
    min-width: 0;
  }

  .page-tabs--segments .page-tab-strip {
    flex: 0 1 auto;
    gap: 0;
    max-width: 100%;
    margin-bottom: 0;
    padding: 2px;
    box-sizing: border-box;
    background: var(--sunk);
    border: 1px solid var(--line);
    border-radius: var(--r-pill);
    box-shadow: none;
  }

  /* Without a head the segments still keep their distance to the panel. */
  .page-tabs--segments > .page-tab-strip {
    margin-bottom: var(--s-6);
  }

  .page-tabs--segments .page-tab {
    min-height: var(--h-control-sm);
    padding: 0 var(--s-3);
    border: 0;
    border-radius: var(--r-pill);
    font-size: var(--fs-sm);
  }

  .page-tabs--segments .page-tab[data-state="active"] {
    background: var(--card);
    color: var(--text);
    box-shadow: var(--shadow);
  }

  .page-tabs--segments .page-tab:focus-visible {
    outline-offset: -2px;
  }

  /* A phone (or any narrow row): the segments take their own line under the head. */
  @container (max-width: 639.98px) {
    .page-tabs-lead {
      flex-basis: 100%;
    }
  }

  /* WCAG 2.5.5 - 44 px hit targets on touch devices. */
  @media (pointer: coarse) {
    .page-tabs--segments .page-tab {
      min-height: 44px;
    }
  }

  .page-tab-panel:focus-visible {
    outline: 2px solid var(--brand);
    outline-offset: 2px;
  }
</style>

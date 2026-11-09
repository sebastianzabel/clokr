<script lang="ts">
  // Issue #843 (D-843-01 block 1) - the page tabs of the Seitenkopf, a private sub-part of
  // PageHeader. bits-ui Tabs gives the roving focus (ArrowLeft/ArrowRight, looping), the automatic
  // activation and the aria-controls link from every trigger to its panel; every panel stays in
  // the DOM (hidden while inactive), so aria-controls never points at nothing.
  //
  // Each bits-ui part renders through its `child` snippet, so the elements are this component's
  // own and the scoped CSS below applies to them.
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
  }

  let { tabs, tab = $bindable(), panel, onTabChange, tabsLabel = "Bereiche" }: Props = $props();

  const current = $derived(tab ?? tabs[0]?.value ?? "");

  function select(next: string) {
    tab = next;
    onTabChange?.(next);
  }
</script>

<Tabs.Root value={current} onValueChange={select} loop activationMode="automatic">
  {#snippet child({ props })}
    <div {...props} class="page-tabs">
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

  .page-tab-panel:focus-visible {
    outline: 2px solid var(--brand);
    outline-offset: 2px;
  }
</style>

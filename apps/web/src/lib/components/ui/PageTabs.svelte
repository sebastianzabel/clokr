<script lang="ts">
  // Issue #843 (D-843-01 block 1) - the page tabs of the Seitenkopf, a private sub-part of
  // PageHeader. bits-ui Tabs gives the roving focus (ArrowLeft/ArrowRight, looping), the automatic
  // activation and the aria-controls link from every trigger to its panel; every panel stays in
  // the DOM (hidden while inactive), so aria-controls never points at nothing.
  //
  // Each bits-ui part renders through its `child` snippet, so the elements are this component's
  // own and the scoped CSS below applies to them.
  //
  // Issue #853 (D-853-05, D-853-11) - two modes. PANEL mode (above) keeps the tab panels on the page.
  // LINK mode: every tab carries an `href` and no `panel` is passed - the tabs are routes of their
  // own, so the strip is a `<nav>` of anchors (the current one marked `aria-current="page"`), not an
  // ARIA tablist. A page places the strip directly under its PageHead. The test ids and the badge
  // click target follow the #840 contract of the old LeaveToolbar (`<prefix>-tabs`, `<prefix>-<tab>`,
  // `<prefix>-<tab>-badge`, `[data-tab-count]`).
  //
  // Issue #854 (owner review of the Personen detail): `look="segments"` draws the panel-mode tablist as
  // a segmented control and, with `head`, places it on the RIGHT of a head row (the prototype's detail
  // head: avatar, name, sub line, segments). The semantics, the roving focus and the panels are the
  // same as the strip's; below 760 px of the row's width the segments wrap under the head and scroll
  // inside their own box, never widening the page.
  import type { Snippet } from "svelte";
  import { Tabs } from "bits-ui";

  interface PageTab {
    /** Control value of the tab, never shown. */
    value: string;
    /** German label of the trigger. */
    label: string;
    /** Link mode (D-853-05): the route of the tab. Every tab needs one, else the strip is a tablist. */
    href?: string;
    /** Own test id suffix (`<testIdPrefix>-<testId>`); defaults to the tab value. */
    testId?: string;
    /** Count shown next to the label; absent or 0 shows none. */
    badge?: number;
    /** Explanation of the count: its title and a screen-reader text. Display text only. */
    badgeLabel?: string;
    /**
     * A pointer click on the count selects the tab and then calls this (panel mode). Keyboard
     * activation of the tab does not call it.
     */
    onBadgeSelect?: () => void;
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
    /** Test ids of the strip, the tabs and their badges (`<prefix>-tabs`, `<prefix>-<tab>`, `…-badge`). */
    testIdPrefix?: string;
    /** Panel mode: "strip" (default) draws underlined tabs; "segments" a segmented control. */
    look?: "strip" | "segments";
    /** Panel mode: rendered in one row BEFORE the tablist (the segments sit on its right). */
    head?: Snippet;
  }

  let {
    tabs,
    tab = $bindable(),
    panel,
    onTabChange,
    tabsLabel = "Bereiche",
    testIdPrefix,
    look = "strip",
    head,
  }: Props = $props();

  const current = $derived(tab ?? tabs[0]?.value ?? "");
  const linkMode = $derived(!panel && tabs.length > 0 && tabs.every((t) => !!t.href));

  function tabTestId(item: PageTab): string | undefined {
    return testIdPrefix ? `${testIdPrefix}-${item.testId ?? item.value}` : undefined;
  }

  // The count is no nested button (a button inside a tab is invalid): the trigger's click handler
  // decides by the event target whether the pointer hit the count. bits-ui has already selected the
  // tab when its own handler ran first.
  function onTriggerClick(e: MouseEvent, item: PageTab, inner: unknown): void {
    (inner as ((ev: MouseEvent) => void) | undefined)?.(e);
    const target = e.target;
    if (item.onBadgeSelect && target instanceof Element && target.closest("[data-tab-count]")) {
      item.onBadgeSelect();
    }
  }

  function select(next: string) {
    tab = next;
    onTabChange?.(next);
  }
</script>

{#snippet badge(item: PageTab)}
  {#if item.badge}
    {#if item.badgeLabel}
      <span
        class="page-tab-badge"
        class:page-tab-badge--link={item.onBadgeSelect}
        title={item.badgeLabel}
        aria-hidden="true"
        data-tab-count
        data-testid={tabTestId(item) ? `${tabTestId(item)}-badge` : undefined}>{item.badge}</span
      >
      <span class="page-tab-sr">{item.badgeLabel}</span>
    {:else}
      <span class="page-tab-badge" data-tab-count>{item.badge}</span>
    {/if}
  {/if}
{/snippet}

{#snippet tabList()}
  <Tabs.List aria-label={tabsLabel}>
    {#snippet child({ props: listProps })}
      <div
        {...listProps}
        class="page-tab-strip"
        data-testid={testIdPrefix ? `${testIdPrefix}-tabs` : undefined}
      >
        {#each tabs as item (item.value)}
          <Tabs.Trigger value={item.value}>
            {#snippet child({ props: triggerProps })}
              <button
                {...triggerProps}
                class="page-tab"
                data-testid={tabTestId(item)}
                onclick={(e) =>
                  onTriggerClick(e, item, (triggerProps as { onclick?: unknown }).onclick)}
              >
                {item.label}{@render badge(item)}
              </button>
            {/snippet}
          </Tabs.Trigger>
        {/each}
      </div>
    {/snippet}
  </Tabs.List>
{/snippet}

{#if linkMode}
  <nav
    class="page-tabs"
    aria-label={tabsLabel}
    data-testid={testIdPrefix ? `${testIdPrefix}-tabs` : undefined}
  >
    <div class="page-tab-strip">
      {#each tabs as item (item.value)}
        <a
          class="page-tab"
          href={item.href}
          aria-current={item.value === current ? "page" : undefined}
          data-testid={tabTestId(item)}
        >
          {item.label}{@render badge(item)}
        </a>
      {/each}
    </div>
  </nav>
{:else}
  <Tabs.Root value={current} onValueChange={select} loop activationMode="automatic">
    {#snippet child({ props })}
      <div {...props} class="page-tabs" class:page-tabs--segments={look === "segments"}>
        {#if head}
          <div class="page-tabs-head">
            <div class="page-tabs-lead">{@render head()}</div>
            {@render tabList()}
          </div>
        {:else}
          {@render tabList()}
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
{/if}

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
    position: relative;
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

  /* Link mode: the anchor looks like the trigger. */
  a.page-tab {
    display: inline-flex;
    align-items: center;
    text-decoration: none;
  }

  .page-tab:hover {
    color: var(--text);
  }

  .page-tab[data-state="active"],
  .page-tab[aria-current="page"] {
    color: var(--brand);
    border-bottom-color: var(--brand);
    font-weight: 600;
  }

  /* Inset ring: the strip clips an outside outline. */
  .page-tab:focus-visible {
    outline: 2px solid var(--brand);
    outline-offset: -2px;
  }

  /* A quiet count pill (#840 G-1): information, not an alarm. */
  .page-tab-badge {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    min-width: 1.125rem;
    height: 1.125rem;
    padding: 0 0.3rem;
    margin-left: 0.375rem;
    border-radius: 9999px;
    background: var(--rail);
    color: var(--text);
    box-shadow: inset 0 0 0 1px var(--line-2);
    font-size: 0.6875rem;
    font-weight: 700;
    line-height: 1;
  }

  .page-tab-badge--link {
    cursor: pointer;
  }

  .page-tab-sr {
    position: absolute;
    width: 1px;
    height: 1px;
    margin: -1px;
    padding: 0;
    overflow: hidden;
    clip: rect(0, 0, 0, 0);
    white-space: nowrap;
    border-width: 0;
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

  /* Without a head the segments still keep their distance to the panel and stay as wide as their
     options (a list page: Berichte, Protokoll). */
  .page-tabs--segments > .page-tab-strip {
    width: fit-content;
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
  @container (max-width: 759.98px) {
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

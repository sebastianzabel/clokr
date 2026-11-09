<script lang="ts">
  /**
   * LeaveToolbar — Issue #840 (D-840-13, E-01). The one header control row of every absence view:
   * the tab bar (the `.view-tabs` recipe, ARIA tabs with one tab stop like `/reports`), the period
   * switcher, the zoom control and a snippet for the view's own filters.
   *
   * It owns no state: the host passes the active tab, the period and the zoom, and learns about
   * a change through the callbacks (the host writes the URL, see `$lib/leave/area-tabs`). The tab
   * panels belong to the host and carry `id="leave-panel-<id>"`.
   */
  import type { Snippet } from "svelte";
  import PeriodSwitcher from "$components/ui/PeriodSwitcher.svelte";
  import SegmentedControl from "$components/ui/SegmentedControl.svelte";
  import type { Period, Zoom } from "$lib/leave/timeline-model";

  interface ToolbarTab {
    id: string;
    label: string;
    /** Count shown next to the label, e.g. pending requests; absent or 0 shows none. */
    badge?: number;
    /**
     * Explanation of the count (Issue #840 G-1): its title and a screen-reader text of the tab.
     * Display text only.
     */
    badgeLabel?: string;
    /**
     * A pointer click on the count calls this instead of `onTabChange`. Keyboard activation of the
     * tab keeps calling `onTabChange`, so the host's own filter control is the keyboard path.
     */
    onBadgeSelect?: () => void;
    /** Own test id suffix (`<testIdPrefix>-<testId>`); defaults to the tab id. */
    testId?: string;
  }

  interface Props {
    ariaLabel: string;
    tabs?: ToolbarTab[];
    activeTab?: string;
    onTabChange?: (id: string) => void;
    period?: Period;
    zooms?: Zoom[];
    zoom?: Zoom;
    onZoomChange?: (zoom: Zoom) => void;
    onShift?: (step: -1 | 1) => void;
    onToday?: () => void;
    filters?: Snippet;
    testIdPrefix?: string;
  }

  let {
    ariaLabel,
    tabs = [],
    activeTab,
    onTabChange,
    period,
    zooms = [],
    zoom,
    onZoomChange,
    onShift,
    onToday,
    filters,
    testIdPrefix,
  }: Props = $props();

  // Display wording of the zoom options; the zoom itself is decided by its code.
  const ZOOM_LABELS: Record<Zoom, string> = { jahr: "Jahr", quartal: "Quartal", monat: "Monat" };

  const zoomOptions = $derived(zooms.map((z) => ({ value: z, label: ZOOM_LABELS[z] })));
  const hasControls = $derived(
    period !== undefined || zoomOptions.length > 0 || filters !== undefined,
  );

  let tablist: HTMLElement | undefined = $state();

  function tabTestId(tab: ToolbarTab): string | undefined {
    return testIdPrefix ? `${testIdPrefix}-${tab.testId ?? tab.id}` : undefined;
  }

  // ARIA tabs with one tab stop: ArrowLeft/ArrowRight wrap, Home/End jump, all of them activate and
  // move the focus with the selection, so the keyboard never loses its place.
  function onTabKeydown(e: KeyboardEvent): void {
    if (tabs.length < 2) return;
    const current = tabs.findIndex((t) => t.id === activeTab);
    const i = current === -1 ? 0 : current;
    let next: number | null = null;
    if (e.key === "ArrowRight") next = (i + 1) % tabs.length;
    else if (e.key === "ArrowLeft") next = (i - 1 + tabs.length) % tabs.length;
    else if (e.key === "Home") next = 0;
    else if (e.key === "End") next = tabs.length - 1;
    if (next === null) return;
    e.preventDefault();
    onTabChange?.(tabs[next].id);
    tablist?.querySelectorAll<HTMLElement>('[role="tab"]')[next]?.focus();
  }

  // The count is no nested button (a button inside a tab is invalid): the tab's click handler decides
  // by the event target whether the pointer hit the count.
  function onTabClick(e: MouseEvent, tab: ToolbarTab): void {
    const target = e.target;
    if (tab.onBadgeSelect && target instanceof Element && target.closest("[data-tab-count]")) {
      tab.onBadgeSelect();
      return;
    }
    onTabChange?.(tab.id);
  }

  function onZoomSelected(value: string): void {
    const picked = zooms.find((z) => z === value);
    if (picked !== undefined) onZoomChange?.(picked);
  }
</script>

<div class="leave-toolbar">
  {#if tabs.length > 0}
    <div
      class="view-tabs"
      role="tablist"
      aria-label={ariaLabel}
      tabindex="-1"
      bind:this={tablist}
      onkeydown={onTabKeydown}
      data-testid={testIdPrefix ? `${testIdPrefix}-tabs` : undefined}
    >
      {#each tabs as tab (tab.id)}
        <button
          type="button"
          class="view-tab"
          class:view-tab--active={tab.id === activeTab}
          role="tab"
          id="leave-tab-{tab.id}"
          aria-selected={tab.id === activeTab}
          aria-controls="leave-panel-{tab.id}"
          tabindex={tab.id === activeTab ? 0 : -1}
          data-testid={tabTestId(tab)}
          onclick={(e) => onTabClick(e, tab)}
        >
          {tab.label}
          {#if tab.badge}
            {#if tab.badgeLabel}
              <span
                class="tab-badge tab-badge--count"
                class:tab-badge--link={tab.onBadgeSelect}
                title={tab.badgeLabel}
                aria-hidden="true"
                data-tab-count
                data-testid={tabTestId(tab) ? `${tabTestId(tab)}-badge` : undefined}
                >{tab.badge}</span
              >
              <span class="sr-only">{tab.badgeLabel}</span>
            {:else}
              <span class="tab-badge">{tab.badge}</span>
            {/if}
          {/if}
        </button>
      {/each}
    </div>
  {/if}

  {#if hasControls}
    <div class="leave-toolbar-controls">
      {#if period && onShift && onToday}
        <div class="leave-toolbar-period">
          <PeriodSwitcher {period} {onShift} {onToday} />
        </div>
      {/if}
      {#if zoomOptions.length > 0 && zoom}
        <SegmentedControl
          options={zoomOptions}
          value={zoom}
          name="leave-zoom"
          ariaLabel="Zeitraum"
          size="sm"
          onchange={onZoomSelected}
        />
      {/if}
      {#if filters}
        <div class="leave-toolbar-filters">{@render filters()}</div>
      {/if}
    </div>
  {/if}
</div>

<style>
  .leave-toolbar {
    display: flex;
    flex-direction: column;
    gap: 0.75rem;
    margin-bottom: 1rem;
  }

  /* The tab strip brings its own bottom margin for pages without a toolbar. */
  .leave-toolbar > :global(.view-tabs) {
    margin-bottom: 0;
  }

  .leave-toolbar-controls {
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    gap: 0.75rem 1rem;
  }

  .leave-toolbar-period {
    /* the .month-bar keeps its own padding and narrow-viewport rules; only the row slot is set */
    flex: 0 1 auto;
    min-width: 0;
  }

  .leave-toolbar-filters {
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    gap: 0.75rem;
    margin-left: auto;
    min-width: 0;
  }

  @media (max-width: 640px) {
    .leave-toolbar-period {
      flex: 1 1 100%;
    }

    .leave-toolbar-filters {
      margin-left: 0;
      flex: 1 1 100%;
    }
  }
</style>

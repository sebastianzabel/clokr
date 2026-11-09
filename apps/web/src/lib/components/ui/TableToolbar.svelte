<script lang="ts" module>
  export interface ToolbarFilterOption {
    value: string;
    label: string;
  }

  export interface ToolbarFilter {
    /** Stable key the caller maps back to its own state. */
    key: string;
    /** Shown name of the filter, e.g. „Salon“. */
    label: string;
    options: ToolbarFilterOption[];
    /** The selected option value; "" while the filter is off. */
    value: string;
  }
</script>

<script lang="ts">
  // Issue #843 (D-843-01 block 6) - the toolbar above a table: pill search, a dashed „+ Filter“
  // button opening a bits-ui popover with each filter's options, one removable chip per active
  // filter and the „x von y“ count in a polite live region. The search text goes through the one
  // normaliser of `$lib/table/search`, so the toolbar and the rows agree on what matches. The
  // component keeps no table state: the caller owns query and filters (usually `urlState()`).
  import { untrack } from "svelte";
  import { Popover, RadioGroup } from "bits-ui";
  import Chip from "./Chip.svelte";
  import { normaliseSearch } from "$lib/table/search";

  interface Props {
    /** Two-way bindable, already normalised search query ("" while empty). */
    query?: string;
    /** Rows that match query and filters, and all rows. */
    count: number;
    total: number;
    filters?: ToolbarFilter[];
    /** Called when the user picked another option (or "" for „Alle“) of a filter. */
    onFilterChange?: (key: string, value: string) => void;
    /**
     * Called by „Filter zurücksetzen“. When given, the caller resets query and all filters in one
     * step (one URL write); without it the toolbar clears the query and calls `onFilterChange`
     * for every active filter.
     */
    onReset?: () => void;
    /** Accessible label of the search input. */
    searchLabel?: string;
  }

  let {
    query = $bindable(""),
    count,
    total,
    filters = [],
    onFilterChange,
    onReset,
    searchLabel = "Suchen",
  }: Props = $props();

  // The id of the "all" radio; a real option value never takes it.
  const ALL = "__all__";

  const uid = $props.id();

  // What the input shows. `query` holds the normalised text, which would swallow the space typed
  // between two words, so the raw text is tracked apart and only re-synced on an outside change.
  let raw = $state(untrack(() => query));
  let open = $state(false);

  $effect(() => {
    const external = query;
    if (normaliseSearch(untrack(() => raw)) !== external) raw = external;
  });

  function onInput(event: Event) {
    raw = (event.currentTarget as HTMLInputElement).value;
    query = normaliseSearch(raw);
  }

  const activeFilters = $derived(
    filters.flatMap((f) => {
      if (f.value === "") return [];
      const option = f.options.find((o) => o.value === f.value);
      return option ? [{ key: f.key, name: f.label, text: `${f.label}: ${option.label}` }] : [];
    }),
  );
  const anyActive = $derived(activeFilters.length > 0 || query !== "");

  function setFilter(key: string, value: string) {
    onFilterChange?.(key, value === ALL ? "" : value);
  }

  function reset() {
    if (onReset) {
      onReset();
      return;
    }
    raw = "";
    query = "";
    for (const f of activeFilters) onFilterChange?.(f.key, "");
  }
</script>

<div class="table-toolbar">
  <div class="tt-bar">
    <div class="tt-search">
      <svg
        class="tt-search-icon"
        aria-hidden="true"
        width="14"
        height="14"
        viewBox="0 0 24 24"
        fill="none"
        stroke="currentColor"
        stroke-width="2"
        stroke-linecap="round"
        stroke-linejoin="round"
      >
        <circle cx="11" cy="11" r="7" />
        <path d="m20 20-3.5-3.5" />
      </svg>
      <input
        class="tt-search-input"
        type="search"
        aria-label={searchLabel}
        placeholder={searchLabel}
        autocomplete="off"
        value={raw}
        oninput={onInput}
      />
    </div>

    {#if filters.length > 0}
      <Popover.Root bind:open>
        <Popover.Trigger class="tt-filter-btn">+ Filter</Popover.Trigger>
        <Popover.Portal>
          <Popover.Content sideOffset={4} collisionPadding={8} align="start">
            {#snippet child({ props, wrapperProps, open: isOpen })}
              {#if isOpen}
                <div {...wrapperProps} class="tt-wrapper">
                  <div {...props} class="tt-pop">
                    {#each filters as filter (filter.key)}
                      <div class="tt-group">
                        <p class="tt-group-title" id="{uid}-{filter.key}">{filter.label}</p>
                        <RadioGroup.Root
                          class="tt-options"
                          aria-labelledby="{uid}-{filter.key}"
                          value={filter.value === "" ? ALL : filter.value}
                          onValueChange={(v) => setFilter(filter.key, v)}
                        >
                          {#each [{ value: ALL, label: "Alle" }, ...filter.options] as option (option.value)}
                            <RadioGroup.Item value={option.value}>
                              {#snippet child({ props: itemProps, checked })}
                                <button
                                  {...itemProps}
                                  class="tt-option"
                                  class:tt-option--on={checked}
                                >
                                  <span class="tt-option-label">{option.label}</span>
                                  {#if checked}
                                    <svg
                                      class="tt-check"
                                      aria-hidden="true"
                                      width="14"
                                      height="14"
                                      viewBox="0 0 24 24"
                                      fill="none"
                                      stroke="currentColor"
                                      stroke-width="2.5"
                                      stroke-linecap="round"
                                      stroke-linejoin="round"
                                    >
                                      <path d="M20 6 9 17l-5-5" />
                                    </svg>
                                  {/if}
                                </button>
                              {/snippet}
                            </RadioGroup.Item>
                          {/each}
                        </RadioGroup.Root>
                      </div>
                    {/each}
                  </div>
                </div>
              {/if}
            {/snippet}
          </Popover.Content>
        </Popover.Portal>
      </Popover.Root>
    {/if}

    {#each activeFilters as active (active.key)}
      <span class="tt-active">
        <Chip tone="neutral">{active.text}</Chip>
        <button
          type="button"
          class="tt-remove"
          aria-label="Filter {active.name} entfernen"
          onclick={() => setFilter(active.key, ALL)}
        >
          <svg
            aria-hidden="true"
            width="12"
            height="12"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            stroke-width="2.5"
            stroke-linecap="round"
            stroke-linejoin="round"
          >
            <path d="M18 6 6 18M6 6l12 12" />
          </svg>
        </button>
      </span>
    {/each}

    {#if anyActive}
      <button type="button" class="tt-reset" onclick={reset}>Filter zurücksetzen</button>
    {/if}

    <span class="tt-count" aria-live="polite" aria-atomic="true">{count} von {total}</span>
  </div>
</div>

<style>
  .table-toolbar {
    container-type: inline-size;
    min-width: 0;
  }

  .tt-bar {
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    gap: var(--s-2);
  }

  .tt-search {
    position: relative;
    flex: 0 1 280px;
    min-width: 160px;
  }

  .tt-search-icon {
    position: absolute;
    top: 50%;
    left: var(--s-3);
    transform: translateY(-50%);
    color: var(--text-3);
    pointer-events: none;
  }

  .tt-search-input {
    width: 100%;
    box-sizing: border-box;
    height: var(--h-control);
    padding: 0 var(--s-3) 0 calc(var(--s-3) + 14px + var(--s-2));
    border: 1px solid var(--line-2);
    border-radius: var(--r-pill);
    background: var(--card);
    color: var(--text);
    font: inherit;
    font-size: var(--fs-base);
  }

  .tt-search-input::placeholder {
    color: var(--text-3);
  }

  .tt-search-input:focus {
    border-color: var(--brand);
    outline: none;
  }

  .table-toolbar :global(.tt-filter-btn) {
    display: inline-flex;
    align-items: center;
    height: var(--h-control);
    padding: 0 var(--s-3);
    border: 1px dashed var(--line-2);
    border-radius: var(--r-pill);
    background: transparent;
    color: var(--text-2);
    font: inherit;
    font-size: var(--fs-sm);
    font-weight: 600;
    cursor: pointer;
  }

  .table-toolbar :global(.tt-filter-btn:hover),
  .table-toolbar :global(.tt-filter-btn[data-state="open"]) {
    border-color: var(--brand);
    background: var(--hover);
    color: var(--text);
  }

  .tt-active {
    display: inline-flex;
    align-items: center;
    gap: 2px;
  }

  .tt-remove {
    display: inline-grid;
    place-items: center;
    width: 22px;
    height: 22px;
    padding: 0;
    border: 0;
    border-radius: var(--r-pill);
    background: transparent;
    color: var(--text-2);
    cursor: pointer;
  }

  .tt-remove:hover {
    background: var(--hover);
    color: var(--text);
  }

  .tt-reset {
    height: var(--h-control-sm);
    padding: 0 var(--s-2);
    border: 0;
    border-radius: var(--r-control);
    background: transparent;
    color: var(--text-2);
    font: inherit;
    font-size: var(--fs-sm);
    text-decoration: underline;
    cursor: pointer;
  }

  .tt-reset:hover {
    color: var(--text);
  }

  .tt-count {
    margin-left: auto;
    color: var(--text-2);
    font-size: var(--fs-sm);
    font-variant-numeric: tabular-nums;
    white-space: nowrap;
  }

  /* The portaled popover renders its own root, so these selectors do not need the block root. */
  .tt-wrapper {
    z-index: 1600;
  }

  .tt-pop {
    display: grid;
    gap: var(--s-3);
    min-width: 220px;
    max-width: min(320px, calc(100vw - 16px));
    max-height: min(420px, 60vh);
    overflow-y: auto;
    padding: var(--s-2);
    border: 1px solid var(--line);
    border-radius: var(--r-card);
    background: var(--card);
    color: var(--text);
    box-shadow: var(--shadow-pop);
  }

  .tt-group {
    min-width: 0;
  }

  .tt-group-title {
    margin: 0;
    padding: var(--s-1) var(--s-3);
    color: var(--text-2);
    font-size: var(--fs-xs);
    font-weight: 600;
  }

  .tt-pop :global(.tt-options) {
    display: grid;
  }

  .tt-option {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: var(--s-2);
    width: 100%;
    min-height: var(--h-control);
    padding: 0 var(--s-3);
    border: 0;
    border-radius: var(--r-control);
    background: transparent;
    color: inherit;
    font: inherit;
    font-size: var(--fs-base);
    text-align: left;
    cursor: pointer;
  }

  .tt-option:hover,
  .tt-option:focus-visible {
    background: var(--hover);
  }

  .tt-option--on {
    font-weight: 600;
  }

  .tt-option-label {
    min-width: 0;
    overflow-wrap: anywhere;
  }

  .tt-check {
    flex-shrink: 0;
    color: var(--brand);
  }

  /* Narrow container: the search takes a full row, the rest wraps below it. */
  @container (max-width: 759.98px) {
    .tt-search {
      flex: 1 1 100%;
    }
  }
</style>

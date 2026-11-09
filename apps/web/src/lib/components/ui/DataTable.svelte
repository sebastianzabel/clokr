<script lang="ts" module>
  import type { SortDirection } from "./SortHeader.svelte";

  export interface DataTableColumn {
    /** Stable key; also the key a sort state refers to. */
    key: string;
    /** Visible head label; on narrow containers the label printed in front of the value. */
    label: string;
    /** The name column: single line, the card title on narrow containers, the row's control. */
    primary?: boolean;
    sortable?: boolean;
    align?: "start" | "end";
    /** Any CSS width for the head cell. */
    width?: string;
  }

  export interface DataTableSort {
    key: string;
    dir: "asc" | "desc";
  }

  /**
   * The one sort cycle of a column head: none -> ascending -> descending -> none. Another column
   * always starts at ascending. `null` means "no sort".
   */
  export function nextSortState(current: DataTableSort | null, key: string): DataTableSort | null {
    if (!current || current.key !== key) return { key, dir: "asc" };
    return current.dir === "asc" ? { key, dir: "desc" } : null;
  }

  export function sortDirectionOf(current: DataTableSort | null, key: string): SortDirection {
    if (!current || current.key !== key) return "none";
    return current.dir === "asc" ? "ascending" : "descending";
  }
</script>

<script lang="ts" generics="Row extends Record<string, unknown>">
  // Issue #843 (D-843-01 block 6, #575, #616) - the table. ONE DOM at every width: a classic table
  // that scrolls horizontally inside its own container, and below 760 px of container width the same
  // cells are restyled into cards that print their column label (`data-label`). The component keeps
  // no table state: sort, search and filters belong to the caller (local state or `urlState()`).
  // Cells are rendered as text through the `cell` snippet as plain text.
  import type { Snippet } from "svelte";
  import EmptyState from "./EmptyState.svelte";
  import Skeleton from "./Skeleton.svelte";
  import SortHeader from "./SortHeader.svelte";

  interface Props {
    columns: DataTableColumn[];
    rows: Row[];
    rowKey: (row: Row) => string | number;
    /** Renders one cell; without it the cell shows `String(row[column.key])`. */
    cell?: Snippet<[Row, DataTableColumn]>;
    sort?: DataTableSort | null;
    /** Called with the next sort state (`null` = back to unsorted). */
    onSort?: (next: DataTableSort | null) => void;
    /** True when the empty `rows` are the result of a search or filter („keine Treffer“). */
    filtered?: boolean;
    onResetFilters?: () => void;
    /** Makes rows clickable; the primary cell becomes the keyboard-focusable control. */
    onRowClick?: (row: Row) => void;
    toolbar?: Snippet;
    /** Accessible table caption (visually hidden). */
    caption: string;
    loading?: boolean;
  }

  let {
    columns,
    rows,
    rowKey,
    cell,
    sort = null,
    onSort,
    filtered = false,
    onResetFilters,
    onRowClick,
    toolbar,
    caption,
    loading = false,
  }: Props = $props();

  function textOf(row: Row, column: DataTableColumn): string {
    const value = row[column.key];
    return value === null || value === undefined ? "" : String(value);
  }

  // A click inside another control of the row (an action button, a link) belongs to that control.
  function onRowActivate(event: MouseEvent, row: Row) {
    const target = event.target as Element | null;
    const control = target?.closest("button, a, input, select, textarea, [role='button']");
    if (control && !control.classList.contains("dt-primary")) return;
    onRowClick?.(row);
  }

  // Enter is handled here and its synthesised click suppressed, so the handler runs exactly once.
  function onPrimaryKeydown(event: KeyboardEvent, row: Row) {
    if (event.key !== "Enter") return;
    event.preventDefault();
    onRowClick?.(row);
  }
</script>

<div class="dt-root" aria-busy={loading ? "true" : undefined}>
  {#if toolbar}
    <div class="dt-toolbar">{@render toolbar()}</div>
  {/if}

  {#if loading}
    <Skeleton shape="row" count={5} />
  {:else if rows.length === 0}
    <EmptyState
      variant={filtered ? "noMatches" : "noData"}
      onaction={filtered ? onResetFilters : undefined}
    />
  {:else}
    <div class="dt-scroll">
      <table class="data-table dt-table">
        <caption class="sr-only">{caption}</caption>
        <thead>
          <tr>
            {#each columns as column (column.key)}
              {#if column.sortable && onSort}
                <SortHeader
                  label={column.label}
                  direction={sortDirectionOf(sort, column.key)}
                  align={column.align}
                  width={column.width}
                  onSort={() => onSort(nextSortState(sort, column.key))}
                />
              {:else}
                <th
                  scope="col"
                  class:dt-end={column.align === "end"}
                  style={column.width ? `width: ${column.width}` : undefined}>{column.label}</th
                >
              {/if}
            {/each}
          </tr>
        </thead>
        <tbody>
          {#each rows as row (rowKey(row))}
            {#if onRowClick}
              <!-- The keyboard path is the primary cell's button; the row click is the pointer
                   convenience of the same action, so the row itself needs no role or tabindex. -->
              <!-- svelte-ignore a11y_click_events_have_key_events, a11y_no_noninteractive_element_interactions -->
              <tr class="dt-row--click" onclick={(e) => onRowActivate(e, row)}>
                {#each columns as column (column.key)}
                  <td
                    data-label={column.label}
                    class:dt-primary-cell={column.primary}
                    class:dt-end={column.align === "end"}
                  >
                    {#if column.primary}
                      <button
                        type="button"
                        class="dt-primary"
                        onkeydown={(e) => onPrimaryKeydown(e, row)}
                      >
                        {#if cell}{@render cell(row, column)}{:else}{textOf(row, column)}{/if}
                      </button>
                    {:else if cell}
                      {@render cell(row, column)}
                    {:else}
                      {textOf(row, column)}
                    {/if}
                  </td>
                {/each}
              </tr>
            {:else}
              <tr>
                {#each columns as column (column.key)}
                  <td
                    data-label={column.label}
                    class:dt-primary-cell={column.primary}
                    class:dt-end={column.align === "end"}
                  >
                    {#if cell}{@render cell(row, column)}{:else}{textOf(row, column)}{/if}
                  </td>
                {/each}
              </tr>
            {/if}
          {/each}
        </tbody>
      </table>
    </div>
  {/if}
</div>

<style>
  .dt-root {
    container-type: inline-size;
    min-width: 0;
  }

  .dt-toolbar {
    margin-bottom: var(--s-3);
  }

  .dt-scroll {
    overflow-x: auto;
    border: 1px solid var(--line);
    border-radius: var(--r-card);
    background: var(--card);
  }

  .dt-table {
    font-size: var(--fs-base);
  }

  .dt-table :global(th) {
    height: var(--h-th);
    padding: 0 var(--s-4);
    font-size: var(--fs-th);
    vertical-align: middle;
  }

  .dt-table td {
    height: var(--h-row);
    padding: 0 var(--s-4);
  }

  .dt-table :global(tbody tr:nth-child(even)) {
    background-color: transparent;
  }

  .dt-table :global(tbody tr:hover) {
    background-color: var(--hover);
  }

  .dt-end {
    text-align: end;
  }

  .dt-primary-cell {
    white-space: nowrap;
    font-weight: 600;
  }

  .dt-row--click {
    cursor: pointer;
  }

  .dt-primary {
    padding: 0;
    border: 0;
    background: transparent;
    color: inherit;
    font: inherit;
    text-align: start;
    white-space: nowrap;
    cursor: pointer;
  }

  .dt-primary:focus-visible {
    outline: 2px solid var(--brand);
    outline-offset: 2px;
    border-radius: var(--r-control);
  }

  /* Narrow container: the same cells become cards. The head row stays for assistive technology. */
  @container (max-width: 759.98px) {
    .dt-scroll {
      overflow: visible;
      border: 0;
      background: transparent;
    }

    .dt-table,
    .dt-table tbody,
    .dt-table tr,
    .dt-table td {
      display: block;
    }

    .dt-table thead {
      position: absolute;
      width: 1px;
      height: 1px;
      overflow: hidden;
      clip-path: inset(50%);
      white-space: nowrap;
    }

    .dt-table :global(tbody tr) {
      margin-bottom: var(--s-3);
      padding: var(--s-2) var(--s-4);
      border: 1px solid var(--line);
      border-radius: var(--r-card);
      background: var(--card);
    }

    .dt-table td {
      display: flex;
      align-items: baseline;
      justify-content: space-between;
      gap: var(--s-3);
      height: auto;
      min-height: var(--h-control);
      padding: var(--s-1) 0;
      border-bottom: 0;
      text-align: end;
    }

    .dt-table td::before {
      content: attr(data-label);
      flex-shrink: 0;
      color: var(--text-2);
      font-size: var(--fs-sm);
      font-weight: 400;
      text-align: start;
    }

    .dt-table td.dt-primary-cell {
      justify-content: flex-start;
      padding-bottom: var(--s-2);
      border-bottom: 1px solid var(--line);
      text-align: start;
    }

    .dt-table td.dt-primary-cell::before {
      display: none;
    }
  }
</style>

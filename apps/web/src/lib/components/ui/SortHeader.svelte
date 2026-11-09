<script lang="ts" module>
  export type SortDirection = "none" | "ascending" | "descending";
</script>

<script lang="ts">
  // Issue #843 (D-843-01 block 6) - the head cell of a sortable column. `aria-sort` sits on the
  // `th` (the ARIA contract for column headers) and the inner button carries the action; the
  // caller owns the state and decides what the next direction is (see `nextSortState` in
  // DataTable.svelte).
  interface Props {
    /** Visible column label; also the object of the button name „Nach <label> sortieren“. */
    label: string;
    direction?: SortDirection;
    onSort: () => void;
    align?: "start" | "end";
    width?: string;
  }

  let { label, direction = "none", onSort, align = "start", width }: Props = $props();
</script>

<th
  scope="col"
  class="sort-header"
  class:sort-header--end={align === "end"}
  aria-sort={direction}
  style={width ? `width: ${width}` : undefined}
>
  <button
    type="button"
    class="sort-header-btn"
    class:sort-header-btn--active={direction !== "none"}
    aria-label="Nach {label} sortieren"
    onclick={onSort}
  >
    <span>{label}</span>
    <svg
      class="sort-header-icon"
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
      {#if direction === "ascending"}
        <path d="m6 15 6-6 6 6" />
      {:else if direction === "descending"}
        <path d="m6 9 6 6 6-6" />
      {:else}
        <path d="m8 9 4-4 4 4M8 15l4 4 4-4" />
      {/if}
    </svg>
  </button>
</th>

<style>
  .sort-header {
    text-align: start;
  }

  .sort-header--end {
    text-align: end;
  }

  .sort-header-btn {
    display: inline-flex;
    align-items: center;
    gap: var(--s-1);
    padding: 0;
    border: 0;
    background: transparent;
    color: inherit;
    font: inherit;
    cursor: pointer;
  }

  .sort-header-btn:hover,
  .sort-header-btn--active {
    color: var(--text);
  }

  .sort-header-btn:focus-visible {
    outline: 2px solid var(--brand);
    outline-offset: 2px;
    border-radius: var(--r-control);
  }

  .sort-header-icon {
    flex-shrink: 0;
    opacity: 0.45;
  }

  .sort-header-btn--active .sort-header-icon {
    opacity: 1;
    color: var(--brand);
  }
</style>

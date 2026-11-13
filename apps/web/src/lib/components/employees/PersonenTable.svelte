<script lang="ts">
  // The ONE person table of Team › Personen and Verwalten › Personen (Issue #854, owner review after #853):
  // same columns (Name with number, Stammsalon, Vertrag, Std./Woche, Rollen, Status, a quiet „Öffnen“),
  // same filters (Salon, Status, Vertrag) and the same row look. The rows come from `personen-model.ts`
  // (`personenRows`, `filterPersonen`, `sortPersonen`); the page owns the data, the URL state and where a
  // row leads. Differences between the two pages are props only: the row's target (`openHref`), the
  // test-id prefix, the row selection of the admin list and its extra toolbar controls (`toolbarExtra`),
  // and a hint under the name (`nameMeta`).
  import type { Snippet } from "svelte";
  import DataTable, {
    type DataTableColumn,
    type DataTableSort,
  } from "$components/ui/DataTable.svelte";
  import TableToolbar, { type ToolbarFilter } from "$components/ui/TableToolbar.svelte";
  import { avatarIndex, initialsOf } from "$components/ui/ListRow.svelte";
  import Chip from "$components/ui/Chip.svelte";
  import { scheduleModelLabel } from "$lib/employees/contract-history";
  import { fmtMin } from "$lib/utils/format-minutes";
  import type { PersonenRow } from "$lib/team/personen-model";
  import { PERSONEN_VERTRAG_CODES } from "$lib/team/personen-url-state";

  interface FilterState {
    status: "aktiv" | "alle";
    vertrag: string;
    salon: string;
  }

  interface Props {
    /** The shown rows: already filtered and sorted by the page. */
    rows: PersonenRow[];
    /** How many rows the list holds before search and filters (the toolbar's „von N“). */
    total: number;
    loading: boolean;
    /** The raw search text and its setter (the page writes it to the URL). */
    query: string;
    onQueryInput: (value: string) => void;
    filter: FilterState;
    /** The Stammsalon filter's choices; null when the page offers none (#64 rule, header salon set). */
    salonOptions: { value: string; label: string }[] | null;
    onFilterChange: (key: "status" | "vertrag" | "salon", value: string) => void;
    onReset: () => void;
    /** Whether a search or a filter narrows the list („keine Treffer“ instead of „keine Daten“). */
    filtered: boolean;
    sort: DataTableSort;
    onSort: (next: DataTableSort | null) => void;
    /** `<prefix>-<id>` on every row. */
    rowTestIdPrefix: string;
    /** Where a row leads; without it the rows open nothing and there is no „Öffnen“ column. */
    openHref?: (row: PersonenRow) => string;
    /** Accessible name of a row's „Öffnen“ link. */
    openLabel?: (row: PersonenRow) => string;
    onOpen?: (row: PersonenRow) => void;
    /** Row selection with a checkbox column (the admin list's bulk changes and CSV export). */
    selectable?: boolean;
    selectedKeys?: (string | number)[];
    /** Rendered under the toolbar (the admin list: „Anonymisierte anzeigen“ and the bulk bar). */
    toolbarExtra?: Snippet;
    /** Rendered under a row's name (a hint chip). */
    nameMeta?: Snippet<[PersonenRow]>;
  }

  let {
    rows,
    total,
    loading,
    query,
    onQueryInput,
    filter,
    salonOptions,
    onFilterChange,
    onReset,
    filtered,
    sort,
    onSort,
    rowTestIdPrefix,
    openHref,
    openLabel = (row) => `${row.name} öffnen`,
    onOpen,
    selectable = false,
    selectedKeys = $bindable([]),
    toolbarExtra,
    nameMeta,
  }: Props = $props();

  // The prototype's filters, identical on both pages: Salon (only with salon choice), Status, Vertrag.
  const toolbarFilters = $derived<ToolbarFilter[]>([
    ...(salonOptions
      ? [
          {
            key: "salon",
            label: "Salon",
            options: salonOptions,
            value: salonOptions.some((option) => option.value === filter.salon) ? filter.salon : "",
          },
        ]
      : []),
    {
      key: "status",
      label: "Status",
      options: [{ value: "aktiv", label: "Aktiv" }],
      value: filter.status === "aktiv" ? "aktiv" : "",
    },
    {
      key: "vertrag",
      label: "Vertrag",
      options: PERSONEN_VERTRAG_CODES.map((code) => ({
        value: code,
        label: scheduleModelLabel(code),
      })),
      value: filter.vertrag,
    },
  ]);

  function onToolbarFilter(key: string, value: string) {
    if (key === "status" || key === "vertrag" || key === "salon") onFilterChange(key, value);
  }

  // The prototype's columns: Name, Stammsalon, Vertrag, Std./Woche, Rollen, Status and „Öffnen“.
  const columns = $derived<DataTableColumn[]>([
    { key: "name", label: "Name", primary: true, sortable: true },
    { key: "salon", label: "Stammsalon", sortable: true },
    { key: "vertrag", label: "Vertrag", sortable: true },
    { key: "stunden", label: "Std./Woche", sortable: true, align: "end" },
    { key: "rollen", label: "Rollen" },
    { key: "status", label: "Status", sortable: true },
    ...(openHref ? [{ key: "open", label: "", align: "end" as const }] : []),
  ]);
</script>

<DataTable
  {columns}
  {rows}
  rowKey={(row) => row.id}
  rowTestId={(row) => `${rowTestIdPrefix}-${row.id}`}
  {sort}
  {onSort}
  {filtered}
  onResetFilters={onReset}
  onRowClick={onOpen}
  {loading}
  caption="Personen"
  {selectable}
  bind:selectedKeys
  selectionLabel={(row) => `${row.sortName} auswählen`}
>
  {#snippet toolbar()}
    <div class="p-controls">
      <TableToolbar
        bind:query={() => query, onQueryInput}
        count={rows.length}
        {total}
        filters={toolbarFilters}
        onFilterChange={onToolbarFilter}
        {onReset}
        searchLabel="Name oder Nummer"
        filterButtons
      />
      {@render toolbarExtra?.()}
    </div>
  {/snippet}
  {#snippet cell(row, column)}
    {#if column.key === "name"}
      <span class="p-name">
        <span
          class="p-avatar"
          style="--av: var(--a{avatarIndex(row.name)}); --av-t: var(--a{avatarIndex(row.name)}-t)"
          aria-hidden="true">{initialsOf(row.name)}</span
        >
        <span class="p-text">
          <span class="p-title">{row.name}</span>
          <span class="p-number">{row.number}</span>
          {#if nameMeta}<span class="p-meta">{@render nameMeta(row)}</span>{/if}
        </span>
      </span>
    {:else if column.key === "salon"}
      {row.salonName}
    {:else if column.key === "vertrag"}
      {row.modelLabel}
    {:else if column.key === "stunden"}
      <span class="p-figure">
        {row.weeklyHours === null ? "–" : fmtMin(Math.round(row.weeklyHours * 60))}
      </span>
    {:else if column.key === "rollen"}
      <span class="p-roles">{row.roles}</span>
    {:else if column.key === "status"}
      <span data-testid={`${rowTestIdPrefix}-${row.id}-status`}>
        <Chip tone={row.statusTone}>{row.statusLabel}</Chip>
      </span>
    {:else if column.key === "open" && openHref}
      <a
        class="p-open row-action"
        href={openHref(row)}
        aria-label={openLabel(row)}
        data-testid={`${rowTestIdPrefix}-${row.id}-open`}>Öffnen</a
      >
    {/if}
  {/snippet}
</DataTable>

<style>
  .p-controls {
    display: flex;
    flex-direction: column;
    gap: var(--s-3);
  }

  .p-name {
    display: inline-flex;
    align-items: center;
    gap: var(--s-3);
    min-width: 0;
  }

  .p-avatar {
    display: inline-flex;
    flex-shrink: 0;
    align-items: center;
    justify-content: center;
    width: 32px;
    height: 32px;
    border-radius: 50%;
    background: var(--av);
    color: var(--av-t);
    font-size: var(--fs-xs);
    font-weight: 600;
  }

  .p-text {
    display: inline-flex;
    flex-direction: column;
    min-width: 0;
    text-align: start;
  }

  .p-title {
    font-weight: 600;
    color: var(--text);
  }

  .p-number {
    color: var(--text-3);
    font-size: var(--fs-xs);
    font-weight: 400;
  }

  .p-meta {
    margin-top: 2px;
  }

  .p-figure {
    font-variant-numeric: tabular-nums;
  }

  /* A quiet text action like the prototype's „Öffnen“ (owner review): no underline, no brand weight. */
  .p-open {
    color: var(--text-2);
    font-weight: 500;
  }

  .p-open:hover {
    color: var(--text);
  }

  .p-roles {
    color: var(--text-2);
  }
</style>

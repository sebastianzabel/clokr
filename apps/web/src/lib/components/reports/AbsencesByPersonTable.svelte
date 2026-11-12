<script lang="ts">
  // Issue #713 (D-03, D-08, D-10) - the section „Abwesenheiten je Person“ of the tab „Urlaub &
  // Abwesenheit“: one row per person of the period answer, one column per absence kind (Krank and
  // Kinderkrank apart), searchable, sortable and paged. Rebuilt on the blocks for Issue #854: a
  // DataTable under a TableToolbar (cards below 760 px of container width). Pattern 3: every figure
  // is the server's `rows[].absence`, formatted here and never summed; the decisions live in
  // `$lib/reports/absence-table`. A column that is 0 for every row of the whole answer is not
  // rendered. It owns no URL and no navigation: the page hands in the person link and decides what
  // a click on it does.
  import { untrack } from "svelte";
  import DataTable, {
    type DataTableColumn,
    type DataTableSort,
  } from "$components/ui/DataTable.svelte";
  import EmptyState from "$components/ui/EmptyState.svelte";
  import Note from "$components/ui/Note.svelte";
  import Pagination from "$components/ui/Pagination.svelte";
  import Skeleton from "$components/ui/Skeleton.svelte";
  import TableToolbar from "$components/ui/TableToolbar.svelte";
  import {
    ABSENCE_UNIT_HINT,
    hiddenAbsenceColumns,
    nextAbsenceSort,
    sortAbsenceRows,
    visibleAbsenceColumns,
    type AbsenceSortKey,
  } from "$lib/reports/absence-table";
  import { fmtDaysDe } from "$lib/reports/period-format";
  import type { PeriodRow } from "$lib/reports/period-report";
  import { filterPeriodRows, type SortDir } from "$lib/reports/period-table";
  import {
    PERSON_VALUES_NOT_SPLIT_LABEL,
    SALON_PERIOD_END_PERSONS_NOTE,
  } from "$lib/salons/page-scope";

  interface Props {
    /** The `rows` of the period answer; null until the first answer. */
    rows: PeriodRow[] | null;
    /** A request is in flight; without rows this renders the skeleton. */
    loading: boolean;
    /** The period label shown under the heading and in the table caption. */
    periodLabel: string;
    /**
     * A salon filter applies: the rows are the Stammsalon persons at the period end with whole
     * values (#714); only the note appears, columns and values stay the same (D-08).
     */
    filterActive: boolean;
    /** The drill-down URL of a person (the name link's `href`; opens in a new tab too). */
    personHref: (row: PeriodRow) => string;
    /** A click on a name link; the page intercepts a plain left click. */
    onOpenPerson: (event: MouseEvent, row: PeriodRow) => void;
  }

  let { rows, loading, periodLabel, filterActive, personHref, onOpenPerson }: Props = $props();

  let search = $state("");
  let sort = $state<{ key: AbsenceSortKey; dir: SortDir }>({ key: "name", dir: "asc" });
  let page = $state(1);
  let pageSize = $state(25);

  const all = $derived(rows ?? []);
  // Which columns exist is decided over the WHOLE answer - never per page or per search.
  const kinds = $derived(visibleAbsenceColumns(all));
  const hiddenKinds = $derived(hiddenAbsenceColumns(all));
  const visible = $derived(sortAbsenceRows(filterPeriodRows(all, search), sort.key, sort.dir));
  // DataTable's row type is a string-keyed record; the interface of the period row has no index
  // signature, so the shown rows carry the intersection.
  type TableRow = PeriodRow & Record<string, unknown>;
  const pageRows = $derived(visible.slice((page - 1) * pageSize, page * pageSize) as TableRow[]);

  // Search and sort apply to all rows before paging; a change returns to page 1.
  $effect(() => {
    void search;
    void sort;
    untrack(() => {
      page = 1;
    });
  });

  const columns = $derived<DataTableColumn[]>([
    { key: "name", label: "Person", primary: true, sortable: true },
    ...kinds.map((c) => ({
      key: c.code,
      label: c.header,
      sortable: true,
      align: "end" as const,
    })),
  ]);

  const tableSort = $derived<DataTableSort>({ key: sort.key, dir: sort.dir });
  // The module's cycle (a kind starts with the most days) decides, not the table's.
  function onSort(next: DataTableSort | null) {
    sort = nextAbsenceSort(sort, (next?.key ?? sort.key) as AbsenceSortKey);
  }

  function resetSearch() {
    search = "";
  }
</script>

{#snippet cell(row: TableRow, column: DataTableColumn)}
  {#if column.key === "name"}
    <span class="abp-person">
      <a
        class="abp-person-link"
        href={personHref(row)}
        data-sveltekit-noscroll
        title={row.employeeName}
        onclick={(e) => onOpenPerson(e, row)}>{row.employeeName}</a
      >
      <span class="abp-sub">{row.employeeNumber}</span>
    </span>
  {:else}
    {fmtDaysDe(row.absence[column.key as keyof PeriodRow["absence"]])}
  {/if}
{/snippet}

<section class="settings-group" aria-labelledby="absences-by-person-title">
  <div>
    <h2 class="settings-group-title" id="absences-by-person-title">Abwesenheiten je Person</h2>
    <p class="settings-group-desc abp-label">{periodLabel}</p>
  </div>

  {#if filterActive}
    <div data-testid="absence-salon-note">
      <Note tone="brand">{SALON_PERIOD_END_PERSONS_NOTE} · {PERSON_VALUES_NOT_SPLIT_LABEL}</Note>
    </div>
  {/if}

  {#if rows === null}
    {#if loading}
      <div data-testid="absence-skeleton">
        <Skeleton shape="row" count={4} />
      </div>
    {/if}
  {:else if rows.length === 0}
    <EmptyState
      icon="users"
      title="Keine Personen im Zeitraum"
      description="In deiner Reichweite war im gewählten Zeitraum niemand beschäftigt. Wähle oben einen anderen Zeitraum."
    />
  {:else if kinds.length === 0}
    <EmptyState icon="inbox" title="Keine Abwesenheiten im Zeitraum." />
  {:else}
    <DataTable
      {columns}
      rows={pageRows}
      rowKey={(row) => row.employeeId}
      rowTestId={(row) => `abp-row-${row.employeeId}`}
      {cell}
      sort={tableSort}
      {onSort}
      filtered={search.trim() !== ""}
      onResetFilters={resetSearch}
      caption={`Abwesenheiten je Person, ${periodLabel}`}
    >
      {#snippet toolbar()}
        <TableToolbar
          bind:query={search}
          count={visible.length}
          total={all.length}
          searchLabel="Name oder Personalnummer suchen"
          onReset={resetSearch}
        />
      {/snippet}
    </DataTable>

    {#if visible.length > 0}
      <Pagination
        total={visible.length}
        bind:page
        bind:pageSize
        pageSizeOptions={[25, 50, 100]}
        labelSingular="Person"
        labelPlural="Personen"
      />
    {/if}

    <p class="settings-group-desc abp-hint" data-testid="absence-unit-hint">{ABSENCE_UNIT_HINT}</p>
    {#if hiddenKinds.length > 0}
      <p class="settings-group-desc abp-hint" data-testid="absence-hidden-hint">
        Ohne Einträge im Zeitraum: {hiddenKinds.map((c) => c.label).join(", ")}
      </p>
    {/if}
  {/if}
</section>

<style>
  .abp-label {
    margin-top: var(--s-1);
  }

  .abp-hint {
    margin-top: 0;
  }

  .abp-person {
    display: flex;
    flex-direction: column;
    align-items: flex-start;
    gap: var(--s-1);
    min-width: 160px;
    max-width: 240px;
    padding-block: var(--s-1);
  }

  .abp-person-link {
    display: block;
    max-width: 100%;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    font-weight: 600;
    line-height: 1.3;
    color: var(--text);
    text-decoration: none;
  }

  .abp-person-link:hover {
    text-decoration: underline;
  }

  .abp-sub {
    font-size: var(--fs-sm);
    line-height: 1.4;
    font-weight: 400;
    color: var(--text-2);
  }

  @container (max-width: 759.98px) {
    .abp-person {
      max-width: 100%;
    }
  }
</style>

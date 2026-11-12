<script lang="ts">
  // Issue #612 (D-612-4, UI-SPEC "Tab Zeiten & Konten") - one row per person for the period:
  // Soll, Ist and the three saldo figures of the server's answer, searchable, sortable and paged.
  // Rebuilt on the blocks for Issue #854: a DataTable (it turns into cards below 760 px of container
  // width) under a TableToolbar. Pattern 3: every figure is the server's (minutes, formatted here);
  // the team median comes from `$lib/reports/team-saldo` (#588 rule), never from a sum of this
  // component. It owns no URL and no navigation: the page hands in the person link and decides what
  // a click on it does.
  import { untrack, type Snippet } from "svelte";
  import Chip from "$components/ui/Chip.svelte";
  import DataTable, {
    type DataTableColumn,
    type DataTableSort,
  } from "$components/ui/DataTable.svelte";
  import EmptyState from "$components/ui/EmptyState.svelte";
  import Note from "$components/ui/Note.svelte";
  import Pagination from "$components/ui/Pagination.svelte";
  import Skeleton from "$components/ui/Skeleton.svelte";
  import TableToolbar from "$components/ui/TableToolbar.svelte";
  import { fmtDateDe, fmtHoursDe } from "$lib/reports/period-format";
  import type { PeriodRow } from "$lib/reports/period-report";
  import {
    filterPeriodRows,
    hasSaldoFigures,
    nextSort,
    rowStatus,
    sortPeriodRows,
    withheldReason,
    type PeriodSortKey,
    type SortDir,
  } from "$lib/reports/period-table";
  import {
    TEAM_SALDO_EXCLUSION_LABEL,
    periodSaldoExclusion,
    periodSaldoFigures,
  } from "$lib/reports/team-saldo"; // Issue #588 (P-12): the one rule
  import {
    HOME_SALON_CHANGE_NOTE,
    PERSON_SALDO_BY_HOME_SALON_LABEL,
    SALON_PERIOD_END_PERSONS_NOTE,
  } from "$lib/salons/page-scope"; // Issue #714: the Stammsalon circle

  interface Props {
    /** The `rows` of the period answer; null until the first answer. */
    rows: PeriodRow[] | null;
    /** A request is in flight; without rows this renders the skeleton. */
    loading: boolean;
    /** The period label shown under the heading and in the table caption. */
    periodLabel: string;
    /**
     * A salon filter applies: the rows are the Stammsalon persons at the period end with whole
     * values (#714); only the note changes, the columns and the status stay.
     */
    filterActive: boolean;
    /** The drill-down URL of a person (the name link's `href`; opens in a new tab too). */
    personHref: (row: PeriodRow) => string;
    /** A click on a name link; the page intercepts a plain left click. */
    onOpenPerson: (event: MouseEvent, row: PeriodRow) => void;
    /** Rendered after the pagination (the exited persons section). */
    exited?: Snippet;
  }

  let { rows, loading, periodLabel, filterActive, personHref, onOpenPerson, exited }: Props =
    $props();

  const DASH = "—";

  let search = $state("");
  let sort = $state<{ key: PeriodSortKey; dir: SortDir }>({ key: "name", dir: "asc" });
  let page = $state(1);
  let pageSize = $state(25);

  const all = $derived(rows ?? []);
  const showSaldo = $derived(hasSaldoFigures(all));
  const visible = $derived(sortPeriodRows(filterPeriodRows(all, search), sort.key, sort.dir));
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

  // The team median of the closing saldi (P-12) and who is outside it. Only where saldo exists.
  const figures = $derived(periodSaldoFigures(all));
  const withoutRecording = $derived(
    figures.excluded.filter((e) => e.reason === "NO_RECORDED_TIME"),
  );

  const columns = $derived<DataTableColumn[]>([
    { key: "name", label: "Person", primary: true, sortable: true },
    { key: "soll", label: "Soll (h)", sortable: true, align: "end" },
    { key: "ist", label: "Ist (h)", sortable: true, align: "end" },
    ...(showSaldo
      ? [
          { key: "opening", label: "Saldo Beginn (h)", sortable: true, align: "end" as const },
          { key: "balance", label: "Saldo Zeitraum (h)", sortable: true, align: "end" as const },
          { key: "closing", label: "Saldo Ende (h)", sortable: true, align: "end" as const },
        ]
      : []),
    { key: "status", label: "Status", sortable: true },
  ]);

  // The table cycles none -> asc -> desc; this page keeps its own cycle (a figure starts at its
  // first direction, a name at ascending) and never sits in "unsorted", so the click is mapped to
  // the column and the module's `nextSort` decides.
  const tableSort = $derived<DataTableSort>({ key: sort.key, dir: sort.dir });
  function onSort(next: DataTableSort | null) {
    sort = nextSort(sort, (next?.key ?? sort.key) as PeriodSortKey);
  }

  function personCount(n: number): string {
    return `${n} ${n === 1 ? "Person" : "Personen"}`;
  }

  // One string, so the separators survive the template's whitespace collapsing.
  const medianText = $derived(
    `Median Saldo am Ende ${
      figures.medianMinutes === null ? DASH : fmtHoursDe(figures.medianMinutes, { signed: true })
    } h${
      withoutRecording.length > 0
        ? ` – ohne ${personCount(withoutRecording.length)} ohne Erfassung`
        : ""
    }`,
  );

  function resetSearch() {
    search = "";
  }
</script>

{#snippet figure(value: number | null, signed: boolean, row: PeriodRow)}
  {#if value === null}
    <span title={withheldReason(row)}>{DASH}</span><span class="sr-only">{withheldReason(row)}</span
    >
  {:else}
    {fmtHoursDe(value, { signed })}
  {/if}
{/snippet}

{#snippet statusChip(row: PeriodRow)}
  {@const status = rowStatus(row)}
  {#if status.kind === "confirmed"}
    <Chip tone="ok">{status.label}</Chip>
  {:else if status.kind === "forecast"}
    <Chip tone="info">{status.label}</Chip>
    {#if status.detail}<span class="period-sub">{status.detail}</span>{/if}
  {:else}
    <Chip tone="neutral">{status.label}</Chip>
  {/if}
{/snippet}

{#snippet cell(row: TableRow, column: DataTableColumn)}
  {#if column.key === "name"}
    {@const exclusion = showSaldo ? periodSaldoExclusion(row) : null}
    <span class="period-person">
      <a
        class="period-person-link"
        href={personHref(row)}
        data-sveltekit-noscroll
        title={row.employeeName}
        onclick={(e) => onOpenPerson(e, row)}>{row.employeeName}</a
      >
      <span class="period-sub">
        {row.employeeNumber}{#if row.exitDay}
          · ausgetreten am {fmtDateDe(row.exitDay)}{/if}
      </span>
      {#if exclusion !== null}
        <Chip tone="neutral" title="Nicht im Median">{TEAM_SALDO_EXCLUSION_LABEL[exclusion]}</Chip>
      {/if}
    </span>
  {:else if column.key === "soll"}
    {@render figure(row.expectedMinutes, false, row)}
  {:else if column.key === "ist"}
    {@render figure(row.workedMinutes, false, row)}
  {:else if column.key === "opening"}
    {@render figure(row.openingBalanceMinutes, true, row)}
  {:else if column.key === "balance"}
    {@render figure(row.balanceMinutes, true, row)}
  {:else if column.key === "closing"}
    {@render figure(row.closingBalanceMinutes, true, row)}
  {:else if column.key === "status"}
    <span class="period-status">{@render statusChip(row)}</span>
  {/if}
{/snippet}

<section
  class="settings-group period-section"
  data-testid="period-section"
  aria-busy={loading}
  aria-labelledby="period-times-title"
>
  <div class="period-section-head">
    <div>
      <h2 class="settings-group-title" id="period-times-title">Zeiten &amp; Konten</h2>
      <p class="settings-group-desc period-label">{periodLabel}</p>
    </div>
    {#if rows !== null && rows.length > 0 && showSaldo}
      <p class="period-median" data-testid="period-median">{medianText}</p>
    {/if}
  </div>

  {#if filterActive}
    <div class="period-notes" data-testid="times-salon-note">
      <Note tone="brand">{SALON_PERIOD_END_PERSONS_NOTE} · {PERSON_SALDO_BY_HOME_SALON_LABEL}</Note>
      <Note tone="brand" icon={false}>{HOME_SALON_CHANGE_NOTE}</Note>
    </div>
  {/if}

  {#if rows === null}
    {#if loading}
      <div data-testid="period-table-skeleton">
        <Skeleton shape="line" count={5} />
      </div>
    {/if}
  {:else if rows.length === 0}
    <EmptyState
      icon="users"
      title="Keine Personen im Zeitraum"
      description="In deiner Reichweite war im gewählten Zeitraum niemand beschäftigt. Wähl oben einen anderen Zeitraum."
    />
  {:else}
    <div class="period-table">
      <DataTable
        {columns}
        rows={pageRows}
        rowKey={(row) => row.employeeId}
        rowTestId={(row) => `period-row-${row.employeeId}`}
        {cell}
        sort={tableSort}
        {onSort}
        filtered={search.trim() !== ""}
        onResetFilters={resetSearch}
        caption={`Zeiten und Konten je Person, ${periodLabel}`}
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
    </div>

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
  {/if}

  {@render exited?.()}
</section>

<style>
  .period-section-head {
    display: flex;
    align-items: flex-end;
    justify-content: space-between;
    flex-wrap: wrap;
    gap: var(--s-2) var(--s-4);
  }

  .period-label {
    margin-top: var(--s-1);
  }

  .period-sub {
    display: block;
    font-size: var(--fs-sm);
    line-height: 1.4;
    color: var(--text-2);
  }

  .period-median {
    margin: 0;
    font-size: var(--fs-base);
    color: var(--text);
    font-variant-numeric: tabular-nums;
  }

  .period-notes {
    display: flex;
    flex-direction: column;
    gap: var(--s-1);
  }

  /* The sticky reference is the page, not the table's scroll box: `.dt-scroll` would clip it with
     overflow-x. Where the container is wide enough for the table the box stays `overflow: visible`
     and the header sits below the topbar AND the period bar; narrower, the table scrolls sideways
     inside the box instead of leaving the page (the sticky header is then given up). */
  .period-table :global(.dt-scroll) {
    overflow: visible;
  }

  .period-table :global(.dt-table thead tr) {
    top: calc(var(--topbar-h) + var(--period-bar-h, 0px));
    background: var(--bg);
    box-shadow: inset 0 -1px 0 var(--line-2);
  }

  .period-table :global(.dt-table td),
  .period-table :global(.dt-table th) {
    padding-inline: var(--s-2);
  }

  @container (max-width: 919.98px) {
    .period-table :global(.dt-scroll) {
      overflow-x: auto;
    }
  }

  .period-person {
    display: flex;
    flex-direction: column;
    align-items: flex-start;
    gap: var(--s-1);
    min-width: 160px;
    max-width: 240px;
    padding-block: var(--s-1);
  }

  .period-person-link {
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

  .period-person-link:hover {
    text-decoration: underline;
  }

  .period-status {
    display: flex;
    flex-direction: column;
    align-items: flex-start;
    gap: var(--s-1);
    min-width: 140px;
  }

  @container (max-width: 759.98px) {
    .period-person {
      max-width: 100%;
    }
  }
</style>

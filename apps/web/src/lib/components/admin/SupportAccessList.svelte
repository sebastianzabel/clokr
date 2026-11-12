<!--
  SupportAccessList — the tenant's list of operator support accesses (Issue #93, AC-93-7, D-08; rebuilt on the
  DataTable block in #854).

  Display only: the page fetches, this component shows what it is given. Instants are written in the
  tenant's time zone (`timezone` from the API), never the browser's. The operator is shown by display
  name only - never an e-mail or an IP (T-854-64). The operator's free-text reason is rendered as text
  (Svelte escaping), never as markup. A row opens the detail through the primary cell's button.

  Props:
    items, total, timezone — the API's list response
    loading, loadError     — request state (loading starts true on the page)
    page, pageSize         — bindable paging state; onPageChange fires after a change
    onOpen                 — opens the detail of one access
    onRetry                — called by „Erneut laden“ in the error banner
-->
<script lang="ts">
  import Chip from "$components/ui/Chip.svelte";
  import DataTable, { type DataTableColumn } from "$components/ui/DataTable.svelte";
  import EmptyState from "$components/ui/EmptyState.svelte";
  import Note from "$components/ui/Note.svelte";
  import Pagination from "$components/ui/Pagination.svelte";
  import {
    endedByLabel,
    formatInZone,
    statusChipTone,
    statusLabel,
    type SupportAccessItem,
  } from "$lib/support-access/labels";

  interface Props {
    items: SupportAccessItem[];
    total: number;
    timezone: string;
    loading: boolean;
    loadError: string;
    page?: number;
    pageSize?: number;
    onOpen: (item: SupportAccessItem) => void;
    onPageChange: () => void;
    onRetry: () => void;
  }

  let {
    items,
    total,
    timezone,
    loading,
    loadError,
    page = $bindable(1),
    pageSize = $bindable(25),
    onOpen,
    onPageChange,
    onRetry,
  }: Props = $props();

  const columns: DataTableColumn[] = [
    { key: "operatorName", label: "Betreiber", primary: true },
    { key: "reason", label: "Grund" },
    { key: "window", label: "Zeitraum" },
    { key: "status", label: "Status" },
    { key: "readCount", label: "Abrufe", align: "end" },
  ];

  function windowOf(item: SupportAccessItem): string {
    const end = item.endedAt ?? item.expiresAt;
    return `${formatInZone(item.startedAt, timezone)} – ${formatInZone(end, timezone)}`;
  }

  function readsLabel(count: number): string {
    return count === 1 ? "1 Abruf" : `${count} Abrufe`;
  }

  const rows = $derived(items.map((item) => ({ ...item })));
</script>

<p class="sa-intro">
  Hier siehst du, wann der Betreiber im Rahmen des Supports auf die Daten deines Unternehmens
  zugegriffen hat, mit welcher Begründung und welche Daten abgerufen wurden. Einen laufenden Zugriff
  kannst du jederzeit beenden.
</p>

{#if loadError}
  <div class="sa-error" role="alert">
    <Note tone="bad">{loadError}</Note>
    <button type="button" class="btn btn-secondary" onclick={onRetry}>Erneut laden</button>
  </div>
{:else if !loading && items.length === 0}
  <EmptyState
    icon="search"
    title="Bisher hat der Betreiber nicht auf die Daten deines Unternehmens zugegriffen."
  />
{:else}
  <DataTable
    {columns}
    {rows}
    rowKey={(row) => row.id}
    caption="Support-Zugriffe, neueste zuerst"
    {loading}
    onRowClick={(row) => onOpen(row)}
    rowTestId={(row) => `support-access-row-${row.id}`}
  >
    {#snippet cell(row, column)}
      {#if column.key === "operatorName"}
        {row.operatorName}
      {:else if column.key === "reason"}
        <span class="sa-reason">{row.reason}</span>
      {:else if column.key === "window"}
        <span class="sa-window">{windowOf(row)}</span>
      {:else if column.key === "status"}
        <Chip tone={statusChipTone(row.status)}>{statusLabel(row.status)}</Chip>
        {#if row.endedBy}
          <span class="sa-muted">{endedByLabel(row.endedBy)}</span>
        {/if}
      {:else if column.key === "readCount"}
        {readsLabel(row.readCount)}
      {/if}
    {/snippet}
  </DataTable>

  {#if !loading}
    <div class="sa-pagination">
      <Pagination
        {total}
        bind:page
        bind:pageSize
        pageSizeOptions={[25, 50, 100]}
        labelSingular="Zugriff"
        labelPlural="Zugriffe"
        onChange={onPageChange}
      />
    </div>
  {/if}
{/if}

<style>
  .sa-intro {
    margin: 0 0 var(--s-3);
    font-size: var(--fs-base);
    line-height: 1.55;
    color: var(--text-2);
    max-width: 70ch;
  }

  .sa-error {
    display: flex;
    flex-direction: column;
    align-items: flex-start;
    gap: var(--s-3);
  }

  /* A reason is free text of the operator: it wraps and is cut after two lines instead of
     widening the table. */
  .sa-reason {
    display: -webkit-box;
    -webkit-line-clamp: 2;
    line-clamp: 2;
    -webkit-box-orient: vertical;
    overflow: hidden;
    white-space: normal;
    overflow-wrap: anywhere;
    min-width: 12rem;
    max-width: 28rem;
  }

  .sa-window {
    font-variant-numeric: tabular-nums;
  }

  .sa-muted {
    margin-left: var(--s-2);
    font-size: var(--fs-sm);
    color: var(--text-2);
  }

  .sa-pagination {
    margin-top: var(--s-3);
  }
</style>

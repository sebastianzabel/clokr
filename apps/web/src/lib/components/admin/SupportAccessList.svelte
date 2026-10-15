<!--
  SupportAccessList — the tenant's list of operator support accesses (Issue #93, AC-93-7, D-08).

  Display only: the page fetches, this component shows what it is given. Instants are written in the
  tenant's time zone (`timezone` from the API), never the browser's. Every row is a real link to the
  detail, so it is keyboard-reachable and nothing is hover-only. The operator's free-text reason is
  rendered as text (Svelte escaping), never as markup.

  Props:
    items, total, timezone — the API's list response
    loading, loadError     — request state (loading starts true on the page)
    page, pageSize         — bindable paging state; onPageChange fires after a change
    onRetry                — called by „Erneut laden“ in the error banner
-->
<script lang="ts">
  import EmptyState from "$components/ui/EmptyState.svelte";
  import Pagination from "$components/ui/Pagination.svelte";
  import {
    endedByLabel,
    formatInZone,
    statusBadgeClass,
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
    onPageChange,
    onRetry,
  }: Props = $props();

  function windowOf(item: SupportAccessItem): string {
    const end = item.endedAt ?? item.expiresAt;
    return `${formatInZone(item.startedAt, timezone)} – ${formatInZone(end, timezone)}`;
  }

  function readsLabel(count: number): string {
    return count === 1 ? "1 Abruf" : `${count} Abrufe`;
  }
</script>

<p class="sa-intro">
  Hier sehen Sie, wann der Betreiber im Rahmen des Supports auf Ihre Daten zugegriffen hat, mit
  welcher Begründung und welche Daten abgerufen wurden. Einen laufenden Zugriff können Sie jederzeit
  beenden.
</p>

{#if loadError}
  <div class="alert alert-error" role="alert">
    <span>⚠</span>
    <span>{loadError}</span>
    <button class="btn btn-outline sm sa-retry" type="button" onclick={onRetry}>
      Erneut laden
    </button>
  </div>
{:else if loading}
  <div class="sa-skeleton" role="status" aria-label="Support-Zugriffe werden geladen">
    <div class="skeleton sa-skel-row"></div>
    <div class="skeleton sa-skel-row"></div>
  </div>
{:else if items.length === 0}
  <EmptyState icon="search" title="Bisher hat der Betreiber nicht auf Ihre Daten zugegriffen." />
{:else}
  <ul class="sa-list" aria-label="Support-Zugriffe">
    {#each items as item (item.id)}
      <li>
        <a class="sa-row" href="/admin/support-access/{item.id}">
          <span class="sa-main">
            <span class="sa-operator">{item.operatorName}</span>
            <span class="sa-reason">{item.reason}</span>
          </span>
          <span class="sa-window">{windowOf(item)}</span>
          <span class="sa-status">
            <span class={statusBadgeClass(item.status)}>{statusLabel(item.status)}</span>
            {#if item.endedBy}
              <span class="sa-muted">{endedByLabel(item.endedBy)}</span>
            {/if}
          </span>
          <span class="sa-count">{readsLabel(item.readCount)}</span>
        </a>
      </li>
    {/each}
  </ul>

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

<style>
  .sa-intro {
    margin: 0 0 12px;
    font-size: 14px;
    line-height: 1.55;
    color: var(--text-muted);
    max-width: 70ch;
  }

  .sa-retry {
    margin-left: auto;
  }

  .sa-skeleton {
    display: flex;
    flex-direction: column;
    gap: 10px;
  }

  .sa-skel-row {
    height: 56px;
    border-radius: var(--r-sm);
  }

  .sa-list {
    list-style: none;
    margin: 0;
    padding: 0;
    display: flex;
    flex-direction: column;
  }

  .sa-list li {
    border-bottom: 1px solid var(--border);
  }

  .sa-list li:last-child {
    border-bottom: none;
  }

  .sa-row {
    display: grid;
    grid-template-columns: minmax(0, 2fr) minmax(0, 1.4fr) auto auto;
    align-items: center;
    gap: 16px;
    padding: 12px 8px;
    border-radius: var(--r-sm);
    color: var(--text);
    text-decoration: none;
    transition: background-color 160ms var(--ease);
  }

  .sa-row:hover,
  .sa-row:focus-visible {
    background: var(--bg-subtle);
    outline: none;
  }

  .sa-row:focus-visible {
    box-shadow: 0 0 0 2px var(--brand);
  }

  .sa-main {
    display: flex;
    flex-direction: column;
    gap: 2px;
    min-width: 0;
  }

  .sa-operator {
    font-weight: 600;
  }

  .sa-reason {
    font-size: 13px;
    color: var(--text-muted);
    overflow-wrap: anywhere;
    display: -webkit-box;
    -webkit-line-clamp: 2;
    line-clamp: 2;
    -webkit-box-orient: vertical;
    overflow: hidden;
  }

  .sa-window {
    font-size: 13px;
    font-variant-numeric: tabular-nums;
  }

  .sa-status {
    display: flex;
    flex-direction: column;
    align-items: flex-start;
    gap: 4px;
  }

  .sa-muted {
    font-size: 12px;
    color: var(--text-muted);
  }

  .sa-count {
    font-size: 13px;
    color: var(--text-muted);
    white-space: nowrap;
    text-align: right;
  }

  .sa-pagination {
    margin-top: 12px;
  }

  @media (max-width: 720px) {
    .sa-row {
      grid-template-columns: minmax(0, 1fr) auto;
      row-gap: 6px;
    }

    .sa-main {
      grid-column: 1 / -1;
    }
  }
</style>

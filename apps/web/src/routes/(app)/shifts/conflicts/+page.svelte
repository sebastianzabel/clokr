<script lang="ts">
  // Phase 67.2 Plan 05 / Issue #850 — "Hinweise zur Schichtplanung".
  //
  // GET /shifts/conflicts answers three buckets (removed automatically, marked, week overbooked).
  // Since #850 the page shows them as ONE list of notices — date, person, reason, action — built
  // by `buildShiftNotices()`; the explanation of each kind sits behind (i). The page is a thin
  // renderer: which shift lands in which bucket stays the API's rule, and the only write is the
  // unchanged POST /shifts/:id/restore (restores a removed shift, clears the mark of a marked one).
  //
  // Default window: 30 days back .. 60 days forward, adjustable with two date inputs.

  import { onMount } from "svelte";
  import { api } from "$api/client";
  import { toasts } from "$stores/toast";
  import PageHead from "$lib/components/layout/PageHead.svelte";
  import {
    buildShiftNotices,
    NOTICE_KINDS,
    type ConflictsResponse,
    type ShiftNotice,
  } from "$lib/shifts/shift-notices";

  let notices = $state<ShiftNotice[]>([]);
  let loading = $state(true);
  let loadError = $state("");
  let busyKey = $state<string | null>(null);

  // Local calendar days (never toISOString, which is the UTC day — see #849).
  function localDay(offsetDays: number): string {
    const d = new Date();
    d.setDate(d.getDate() + offsetDays);
    const pad = (n: number) => String(n).padStart(2, "0");
    return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
  }

  let fromDate = $state(localDay(-30));
  let toDate = $state(localDay(60));

  async function load() {
    loading = true;
    loadError = "";
    try {
      const res = await api.get<ConflictsResponse>(
        `/shifts/conflicts?from=${fromDate}&to=${toDate}`,
      );
      notices = buildShiftNotices(res);
    } catch (err) {
      loadError = err instanceof Error ? err.message : "Die Hinweise konnten nicht geladen werden.";
      notices = [];
    } finally {
      loading = false;
    }
  }

  async function restore(notice: ShiftNotice) {
    if (notice.action.type !== "restore") return;
    busyKey = notice.key;
    try {
      await api.post(`/shifts/${notice.action.shiftId}/restore`, {});
      toasts.success(notice.action.doneToast, 2000);
      await load(); // the shift drops out of the list
    } catch (err) {
      toasts.error(err instanceof Error ? err.message : "Das hat nicht geklappt.", 4000);
    } finally {
      busyKey = null;
    }
  }

  onMount(load);
</script>

<svelte:head>
  <title>Hinweise zur Schichtplanung – Clokr</title>
</svelte:head>

<PageHead eyebrow="Schichtplanung" title="Hinweise zur Schichtplanung" />

<section class="page">
  <div class="card-animate filter-card">
    <label class="filter-field">
      <span class="filter-label">Von</span>
      <input
        type="date"
        class="form-input"
        bind:value={fromDate}
        onchange={load}
        disabled={loading}
      />
    </label>
    <label class="filter-field">
      <span class="filter-label">Bis</span>
      <input
        type="date"
        class="form-input"
        bind:value={toDate}
        onchange={load}
        disabled={loading}
      />
    </label>
  </div>

  {#if loadError}
    <div class="callout error">{loadError}</div>
  {/if}

  <section class="card-animate notice-card" aria-label="Hinweise">
    {#if loading}
      <p class="empty">Lädt…</p>
    {:else if notices.length === 0 && !loadError}
      <p class="empty">Keine Hinweise im Zeitraum. Alles passt.</p>
    {:else}
      <ul class="notice-list" data-testid="shift-notice-list">
        {#each notices as n (n.key)}
          <li class="notice-row" data-testid="shift-notice" data-kind={n.kind}>
            <div class="notice-date">{n.dateLabel}</div>
            <div class="notice-main">
              <div class="notice-person">
                {n.person}
                {#if n.detail}<span class="notice-detail">{n.detail}</span>{/if}
              </div>
              <div class="notice-reason">
                <span class="badge {n.kind === 'removed' ? 'badge-red' : 'badge-yellow'}"
                  >{NOTICE_KINDS[n.kind].badge}</span
                >
                <span>{n.reason}</span>
                <details class="notice-info">
                  <summary aria-label="Erklärung: {NOTICE_KINDS[n.kind].badge}">i</summary>
                  <p>{NOTICE_KINDS[n.kind].explanation}</p>
                </details>
              </div>
            </div>
            <div class="notice-action">
              {#if n.action.type === "restore"}
                <button
                  type="button"
                  class="btn btn-secondary btn-sm"
                  onclick={() => restore(n)}
                  disabled={busyKey !== null}
                >
                  {busyKey === n.key ? "Einen Moment…" : n.action.label}
                </button>
              {:else}
                <a class="btn btn-ghost btn-sm" href={n.action.href}>{n.action.label}</a>
              {/if}
            </div>
          </li>
        {/each}
      </ul>
    {/if}
  </section>
</section>

<style>
  .filter-card {
    display: flex;
    flex-wrap: wrap;
    gap: var(--s-4);
    align-items: end;
    padding: var(--s-6);
    background: var(--card);
    border: 1px solid var(--line);
    border-radius: var(--r-card);
  }

  .filter-field {
    display: flex;
    flex-direction: column;
    gap: var(--s-1);
  }

  .filter-label {
    font-size: 0.8125rem;
    font-weight: 600;
    color: var(--text-2);
  }

  .notice-card {
    background: var(--card);
    border: 1px solid var(--line);
    border-radius: var(--r-card);
    padding: var(--s-6);
  }

  .empty {
    margin: 0;
    color: var(--text-2);
  }

  .notice-list {
    list-style: none;
    margin: 0;
    padding: 0;
    display: flex;
    flex-direction: column;
  }

  .notice-row {
    display: grid;
    grid-template-columns: 11rem 1fr auto;
    align-items: start;
    gap: var(--s-3);
    padding: var(--s-3) 0;
    border-top: 1px solid var(--line);
    color: var(--text);
  }
  .notice-row:first-child {
    border-top: 0;
  }

  .notice-date {
    font-weight: 600;
    white-space: nowrap;
  }

  .notice-main {
    display: flex;
    flex-direction: column;
    gap: var(--s-1);
    min-width: 0;
  }

  .notice-person {
    font-weight: 600;
  }

  .notice-detail {
    margin-left: var(--s-2);
    font-weight: 400;
    color: var(--text-2);
    font-size: 0.875rem;
  }

  .notice-reason {
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    gap: var(--s-2);
    color: var(--text-2);
    font-size: 0.875rem;
  }

  .notice-info summary {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    width: 1.25rem;
    height: 1.25rem;
    border: 1px solid var(--line);
    border-radius: 50%;
    font-style: italic;
    font-size: 0.75rem;
    cursor: pointer;
    list-style: none;
  }
  .notice-info summary::-webkit-details-marker {
    display: none;
  }
  .notice-info[open] {
    flex-basis: 100%;
  }
  .notice-info p {
    margin: var(--s-2) 0 0;
    max-width: 60ch;
    color: var(--text-2);
  }

  .notice-action {
    white-space: nowrap;
  }

  @media (max-width: 720px) {
    .notice-row {
      grid-template-columns: 1fr;
      gap: var(--s-2);
    }
    .notice-action .btn {
      width: 100%;
    }
  }
</style>

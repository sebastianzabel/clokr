<script lang="ts">
  // Phase 67.2 Plan 05 — Manager-facing Schicht-Konflikt-Übersicht.
  //
  // Lists soft-deleted (deletedReason=AUTO_BS_DAY_CLEANUP) and currently-flagged
  // (conflictsWithLeave=true) shifts in two sections. Each row has a
  // "Wiederherstellen" button that POSTs to /shifts/:id/restore.
  //
  // Default window: 30 days back .. 60 days forward. Adjustable via two date
  // inputs at the top. Page re-fetches on date change.

  import { onMount } from "svelte";
  import { api } from "$api/client";
  import { toasts } from "$stores/toast";
  import PageHead from "$lib/components/layout/PageHead.svelte";
  import ShiftConflictRow from "$components/ShiftConflictRow.svelte";

  interface ConflictShift {
    id: string;
    date: string;
    startTime: string;
    endTime: string;
    label: string | null;
    employee: { firstName: string; lastName: string };
    deletedAt: string | null;
    deletedReason: string | null;
    conflictsWithLeave: boolean;
  }

  interface ConflictsResponse {
    softDeleted: ConflictShift[];
    flagged: ConflictShift[];
  }

  let softDeleted = $state<ConflictShift[]>([]);
  let flagged = $state<ConflictShift[]>([]);
  let loading = $state(true);
  let loadError = $state("");
  let restoringId = $state<string | null>(null);

  // Default window helpers — pure functions, executed once at mount.
  function defaultFrom(): string {
    const d = new Date();
    d.setDate(d.getDate() - 30);
    return d.toISOString().slice(0, 10);
  }
  function defaultTo(): string {
    const d = new Date();
    d.setDate(d.getDate() + 60);
    return d.toISOString().slice(0, 10);
  }

  let fromDate = $state(defaultFrom());
  let toDate = $state(defaultTo());

  async function load() {
    loading = true;
    loadError = "";
    try {
      const res = await api.get<ConflictsResponse>(
        `/shifts/conflicts?from=${fromDate}&to=${toDate}`,
      );
      softDeleted = res.softDeleted;
      flagged = res.flagged;
    } catch (err) {
      loadError = err instanceof Error ? err.message : "Konflikte konnten nicht geladen werden.";
      softDeleted = [];
      flagged = [];
    } finally {
      loading = false;
    }
  }

  async function restore(id: string) {
    restoringId = id;
    try {
      await api.post(`/shifts/${id}/restore`, {});
      toasts.success("Schicht wiederhergestellt", 2000);
      await load(); // refetch — restored shift drops out of both buckets
    } catch (err) {
      const msg = err instanceof Error ? err.message : "Wiederherstellung fehlgeschlagen";
      toasts.error(msg, 4000);
    } finally {
      restoringId = null;
    }
  }

  onMount(load);
</script>

<svelte:head>
  <title>Schicht-Konflikte – Clokr</title>
</svelte:head>

<PageHead eyebrow="Schichtplanung" title="Schicht-Konflikte" />

<section class="page">
  <!-- Date-range filters -->
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
    <button type="button" class="btn btn-secondary btn-sm" onclick={load} disabled={loading}>
      {loading ? "Lädt…" : "Aktualisieren"}
    </button>
  </div>

  {#if loadError}
    <div class="callout error">{loadError}</div>
  {/if}

  <!-- Section: soft-deleted (auto-cleanup) -->
  <section class="card-animate conflict-section">
    <header class="conflict-section-head">
      <h2>Automatisch entfernte Schichten</h2>
      <p class="conflict-section-hint">
        Schichten, die der Generator beim Anlegen neuer Berufsschultage automatisch entfernt hat.
        Per "Wiederherstellen" zurückholbar — eine SHIFT_RESTORED-Audit-Spur wird erzeugt.
      </p>
    </header>

    {#if loading}
      <p class="empty">Lädt…</p>
    {:else if softDeleted.length === 0}
      <p class="empty">Keine entfernten Schichten im Zeitraum.</p>
    {:else}
      <div class="rows">
        {#each softDeleted as s (s.id)}
          <ShiftConflictRow shift={s} onRestore={restore} restoring={restoringId === s.id} />
        {/each}
      </div>
    {/if}
  </section>

  <!-- Section: actively-flagged (past or current conflicts) -->
  <section class="card-animate conflict-section">
    <header class="conflict-section-head">
      <h2>Markierte Schichten</h2>
      <p class="conflict-section-hint">
        Schichten mit Konflikt-Flag (z.B. Vergangenheits-Schichten an neu angelegten BS-Tagen oder
        Schichten in zeitgleichem Urlaub). "Wiederherstellen" löscht den Konflikt-Flag.
      </p>
    </header>

    {#if loading}
      <p class="empty">Lädt…</p>
    {:else if flagged.length === 0}
      <p class="empty">Keine markierten Schichten im Zeitraum.</p>
    {:else}
      <div class="rows">
        {#each flagged as s (s.id)}
          <ShiftConflictRow shift={s} onRestore={restore} restoring={restoringId === s.id} />
        {/each}
      </div>
    {/if}
  </section>
</section>

<style>
  .filter-card {
    display: flex;
    flex-wrap: wrap;
    gap: var(--s-4);
    align-items: end;
    padding: var(--pad-card);
    background: var(--bg-card);
    border: 1px solid var(--border);
    border-radius: var(--r-lg);
  }

  .filter-field {
    display: flex;
    flex-direction: column;
    gap: var(--s-1);
  }

  .filter-label {
    font-size: 0.8125rem;
    font-weight: 600;
    color: var(--text-muted);
  }

  .conflict-section {
    background: var(--bg-card);
    border: 1px solid var(--border);
    border-radius: var(--r-lg);
    padding: var(--pad-card);
    display: flex;
    flex-direction: column;
    gap: var(--s-4);
  }

  .conflict-section-head h2 {
    margin: 0 0 var(--s-2);
    color: var(--text);
    font-size: 1.125rem;
    font-weight: 600;
  }

  .conflict-section-hint {
    margin: 0;
    color: var(--text-muted);
    font-size: 0.875rem;
  }

  .empty {
    margin: 0;
    color: var(--text-muted);
    font-style: italic;
  }

  .rows {
    display: flex;
    flex-direction: column;
    gap: var(--s-2);
  }
</style>

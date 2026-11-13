<script lang="ts">
  // Phase 67.2 Plan 05 / Issue #850 — "Hinweise zur Schichtplanung".
  //
  // GET /shifts/conflicts answers three buckets (removed automatically, marked, week overbooked).
  // Since #850 the page shows them as ONE list of notices — date, person, reason, action — built
  // by `buildShiftNotices()`; the explanation of each kind sits behind (i). The page is a thin
  // renderer: which shift lands in which bucket stays the API's rule, and the only write is the
  // unchanged POST /shifts/:id/restore (restores a removed shift, clears the mark of a marked one).
  //
  // Issue #853 (D-853-18): the fourth tab of Dienstplan - the v2 head with the link tabs, the date
  // window in one row and the notices as one List. The old filter card, notice card and hand-built
  // list markup are replaced, not wrapped.
  //
  // Default window: 30 days back .. 60 days forward, adjustable with two date inputs.

  import { onMount } from "svelte";
  import { api } from "$api/client";
  import { authStore } from "$stores/auth";
  import { tenantFeatures } from "$stores/tenant-features";
  import { toasts } from "$stores/toast";
  import PageHead from "$lib/components/layout/PageHead.svelte";
  import TeamSection from "$lib/components/team/TeamSection.svelte";
  import { pageLabel } from "$lib/nav/page-labels";
  import { rosterTabs } from "$lib/nav/routes";
  import PageTabs from "$components/ui/PageTabs.svelte";
  import FormField from "$components/ui/FormField.svelte";
  import List from "$components/ui/List.svelte";
  import ListRow from "$components/ui/ListRow.svelte";
  import Chip from "$components/ui/Chip.svelte";
  import EmptyState from "$components/ui/EmptyState.svelte";
  import ErrorState from "$components/ui/ErrorState.svelte";
  import Skeleton from "$components/ui/Skeleton.svelte";
  import {
    buildShiftNotices,
    NOTICE_KINDS,
    type ConflictsResponse,
    type NoticeKind,
    type ShiftNotice,
  } from "$lib/shifts/shift-notices";

  // The four roster tabs are the link tabs of the route table (D-853-05).
  const rosterTabsList = $derived(
    rosterTabs($authStore.user, { availabilityEnabled: $tenantFeatures.availabilityEnabled }),
  );

  const KIND_TONE: Record<NoticeKind, "bad" | "warn"> = {
    removed: "bad",
    marked: "warn",
    "week-overbooked": "warn",
  };

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
  <title>{pageLabel("/shifts/conflicts")} – Clokr</title>
</svelte:head>

<PageHead
  title={pageLabel("/shifts/conflicts")}
  sub="Schichten, die automatisch entfernt wurden oder noch einmal geprüft werden sollten."
/>
<PageTabs tabs={rosterTabsList} tab="/team/dienstplan/konflikte" tabsLabel="Dienstplan" />

<div class="page">
  <!-- The window of the list: two dates and the reload, one row. -->
  <div class="notice-window">
    <FormField label="Von">
      {#snippet field({ id, describedBy })}
        <input
          {id}
          aria-describedby={describedBy}
          type="date"
          class="form-input"
          bind:value={fromDate}
          onchange={load}
          disabled={loading}
        />
      {/snippet}
    </FormField>
    <FormField label="Bis">
      {#snippet field({ id, describedBy })}
        <input
          {id}
          aria-describedby={describedBy}
          type="date"
          class="form-input"
          bind:value={toDate}
          onchange={load}
          disabled={loading}
        />
      {/snippet}
    </FormField>
    <button type="button" class="btn btn-secondary" onclick={load} disabled={loading}>
      Aktualisieren
    </button>
  </div>

  <TeamSection title="Hinweise zur Schichtplanung">
    {#if loadError}
      <ErrorState message={loadError} onRetry={load} retrying={loading} />
    {:else if loading}
      <Skeleton shape="row" count={3} />
    {:else if notices.length === 0}
      <EmptyState icon="calendar" title="Keine Hinweise im Zeitraum" description="Alles passt." />
    {:else}
      <List ariaLabel="Hinweise zur Schichtplanung" testId="shift-notice-list">
        {#each notices as n (n.key)}
          <ListRow
            variant="task"
            testId="shift-notice"
            kind={n.kind}
            title={n.person}
            subtitle={n.detail ? `${n.dateLabel} · ${n.detail}` : n.dateLabel}
          >
            {#snippet meta()}
              <Chip tone={KIND_TONE[n.kind]}>{NOTICE_KINDS[n.kind].badge}</Chip>
              <span class="notice-reason">{n.reason}</span>
              <details class="notice-info">
                <summary aria-label="Erklärung: {NOTICE_KINDS[n.kind].badge}">i</summary>
                <p>{NOTICE_KINDS[n.kind].explanation}</p>
              </details>
            {/snippet}
            {#snippet actions()}
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
            {/snippet}
          </ListRow>
        {/each}
      </List>
    {/if}
  </TeamSection>
</div>

<style>
  /* The window of the list: the two dates and the reload on one row, aligned on the field bottoms. */
  .notice-window {
    display: flex;
    flex-wrap: wrap;
    align-items: flex-end;
    gap: var(--s-3);
  }

  .notice-reason {
    color: var(--text-2);
    font-size: var(--fs-sm);
  }

  /* The explanation behind (i): the opened text takes its own line under the reason. */
  .notice-info summary {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    width: 1.25rem;
    height: 1.25rem;
    border: 1px solid var(--line);
    border-radius: 50%;
    font-size: var(--fs-xs);
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
    font-size: var(--fs-sm);
  }
</style>

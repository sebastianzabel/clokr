<!--
  PhorestSyncPanel - the „Abgleich“ tab of Verwalten › System › Phorest (Issue #854, rebuilt on the blocks of
  #843; the data, the endpoints and the rules are those of the pre-#854 page `/admin/phorest`). A section without
  configuration keys of its own: it runs the shift sync and reads its history.

  - „Jetzt abgleichen“ posts `POST /integrations/phorest/sync-shifts` for the chosen Von/Bis, or for today up to
    today plus the sync window of the connection (`syncRange`). The button is disabled while a run is in progress;
    the result is a toast and, for a refused or suspect run, a note with the reason (no shift was cancelled).
  - „Letzter Lauf“ is a KpiStrip of the latest run, „Verlauf“ the run history as a DataTable with the server's own
    paging (`GET /integrations/phorest/sync-runs?limit&page`).

  The runs are read once the connection is configured, which this panel learns from the shared `status`.
  Presentation only: `integration:manage` is checked by the API.

  Props:
    status   - bindable, what the page's status strip shows; this panel writes the latest run
    onsynced - called after a run, so the mapping table can reload (the unmapped figures may have changed)
-->
<script lang="ts">
  import { untrack } from "svelte";
  import { api } from "$api/client";
  import { toasts } from "$stores/toast";
  import Chip from "$components/ui/Chip.svelte";
  import DataTable, { type DataTableColumn } from "$components/ui/DataTable.svelte";
  import FormField from "$components/ui/FormField.svelte";
  import KpiStrip from "$components/ui/KpiStrip.svelte";
  import Note from "$components/ui/Note.svelte";
  import Pagination from "$components/ui/Pagination.svelte";
  import Skeleton from "$components/ui/Skeleton.svelte";
  import Spinner from "$components/ui/Spinner.svelte";
  import {
    runStatusLabel,
    runStatusTone,
    syncRange,
    type PhorestStatus,
    type PhorestSyncRun,
  } from "$lib/settings/phorest";

  interface Props {
    status: PhorestStatus;
    onsynced?: () => void;
  }

  let { status = $bindable(), onsynced }: Props = $props();

  let runs: PhorestSyncRun[] = $state([]);
  let runsTotal = $state(0);
  let runsLoading = $state(false);
  let page = $state(1);
  let pageSize = $state(10);

  let syncStart = $state("");
  let syncEnd = $state("");
  let syncing = $state(false);
  let syncError = $state("");

  const latest = $derived(status.latestRun);

  const columns: DataTableColumn[] = [
    { key: "startedAt", label: "Zeitpunkt", primary: true },
    { key: "status", label: "Status" },
    { key: "created", label: "Importiert", align: "end" },
    { key: "cancelled", label: "Abgesagt", align: "end" },
    { key: "unmapped", label: "Ohne Zuordnung", align: "end" },
    { key: "skippedVocationalSchool", label: "BS übersprungen", align: "end" },
    { key: "replaced", label: "Ersetzt", align: "end" },
  ];

  const stamp = (iso: string) => new Date(iso).toLocaleString("de-DE");

  const latestItems = $derived(
    latest
      ? [
          { label: "Importiert", value: String(latest.created) },
          { label: "Aktualisiert", value: String(latest.updated) },
          {
            label: "Ersetzt",
            value: String(latest.replaced ?? 0),
            deltaTone: (latest.replaced ?? 0) > 0 ? ("warn" as const) : ("neutral" as const),
          },
          { label: "Abgesagt", value: String(latest.cancelled) },
          { label: "BS übersprungen", value: String(latest.skippedVocationalSchool ?? 0) },
          {
            label: "Ohne Zuordnung",
            value: String(latest.unmapped),
            deltaTone: latest.unmapped > 0 ? ("warn" as const) : ("neutral" as const),
          },
        ]
      : [],
  );

  async function loadRuns() {
    runsLoading = true;
    try {
      const res = await api.get<{
        latest: PhorestSyncRun | null;
        history: PhorestSyncRun[];
        total: number;
      }>(`/integrations/phorest/sync-runs?limit=${pageSize}&page=${page - 1}`);
      status.latestRun = res.latest;
      runs = res.history ?? [];
      runsTotal = res.total ?? 0;
    } catch {
      // Not fatal: the history stays as it was.
    } finally {
      runsLoading = false;
    }
  }

  // The runs are read once, as soon as the connection is known to be configured.
  let started = false;
  $effect(() => {
    if (!status.configured || started) return;
    started = true;
    untrack(() => void loadRuns());
  });

  async function syncNow() {
    syncing = true;
    syncError = "";
    // Optimistic: the latest run reads „Läuft“ until the refresh arrives.
    if (status.latestRun) status.latestRun = { ...status.latestRun, status: "RUNNING" };
    const { startDate, endDate } = syncRange(syncStart, syncEnd, status.syncWindowDays);
    try {
      // Phase 65b (issue #65, D-13): the response is a per-salon aggregate; the top-level fields below are all
      // this panel reads.
      const res = await api.post<{
        status: "SUCCESS" | "ERROR" | "SUSPECT";
        created: number;
        updated: number;
        cancelled: number;
        unmapped: number;
        error?: string;
      }>("/integrations/phorest/sync-shifts", { startDate, endDate });
      if (res.status === "SUCCESS") {
        toasts.success(
          `${res.created} Schichten importiert · ${res.cancelled} abgesagt · ${res.unmapped} ohne Zuordnung`,
        );
      } else {
        // ERROR or SUSPECT (guardrail): the reason is shown, nothing was cancelled.
        const reason = (res.error ?? "Unbekannter Fehler").replace(/[.\s]+$/, "");
        syncError = `Der Abgleich ist fehlgeschlagen: ${reason}. Es wurden keine Schichten abgesagt. Versuch es bitte erneut.`;
        toasts.error("Der Abgleich war nicht erfolgreich.");
      }
      await loadRuns();
      onsynced?.();
    } catch (err) {
      syncError = err instanceof Error ? err.message : "Der Abgleich ist fehlgeschlagen.";
      await loadRuns();
    } finally {
      syncing = false;
    }
  }
</script>

<section class="settings-group" aria-labelledby="phorest-abgleich-title">
  <h2 class="settings-group-title" id="phorest-abgleich-title">Schichten abgleichen</h2>
  <p class="settings-group-desc">
    Clokr übernimmt die Schichten aus Phorest. Phorest bleibt dabei die Quelle der Schichtplanung.
  </p>

  {#if !status.configured}
    <Note tone="info">Speichere zuerst die Zugangsdaten unter „Verbindung“.</Note>
  {:else}
    <div class="ps-range">
      <FormField label="Von" help="Ohne Angabe gilt das Zeitfenster der Verbindung.">
        {#snippet field({ id, describedBy })}
          <input
            {id}
            class="form-input"
            type="date"
            bind:value={syncStart}
            disabled={syncing}
            aria-describedby={describedBy}
          />
        {/snippet}
      </FormField>
      <FormField label="Bis">
        {#snippet field({ id, describedBy })}
          <input
            {id}
            class="form-input"
            type="date"
            bind:value={syncEnd}
            disabled={syncing}
            aria-describedby={describedBy}
          />
        {/snippet}
      </FormField>
    </div>
    <p class="ps-hint">
      Ohne Von und Bis gleicht Clokr von heute bis heute plus {status.syncWindowDays} Tage ab.
    </p>

    <div class="ps-actions">
      <button type="button" class="btn btn-primary" onclick={syncNow} disabled={syncing}>
        {#if syncing}<Spinner size={14} label="Abgleich läuft" />{/if}
        Jetzt abgleichen
      </button>
    </div>

    {#if syncError}
      <div role="alert"><Note tone="bad">{syncError}</Note></div>
    {/if}
  {/if}
</section>

{#if status.configured}
  <section class="settings-group" aria-labelledby="phorest-letzter-lauf-title">
    <h2 class="settings-group-title" id="phorest-letzter-lauf-title">Letzter Lauf</h2>
    {#if runsLoading && !latest}
      <Skeleton shape="row" count={1} />
    {:else if latest}
      <p class="ps-run-head">
        <Chip tone={runStatusTone(latest.status)}>{runStatusLabel(latest.status)}</Chip>
        <span class="ps-run-time">{stamp(latest.startedAt)}</span>
      </p>
      <KpiStrip items={latestItems} ariaLabel="Zahlen des letzten Laufs" />
      {#if latest.status === "ERROR" && latest.error}
        <div role="alert"><Note tone="bad">{latest.error}</Note></div>
      {:else if latest.status === "SUSPECT" && latest.error}
        <div role="alert"><Note tone="warn">{latest.error}</Note></div>
      {/if}
    {:else}
      <p class="ps-hint">Noch kein Abgleich gelaufen. Starte einen manuellen Abgleich.</p>
    {/if}
  </section>

  {#if runsTotal > 0}
    <section class="settings-group" aria-labelledby="phorest-verlauf-title">
      <h2 class="settings-group-title" id="phorest-verlauf-title">Verlauf</h2>
      <DataTable
        {columns}
        rows={runs}
        rowKey={(row) => row.id}
        loading={runsLoading && runs.length === 0}
        caption="Verlauf der Abgleiche mit Status und Zahlen"
      >
        {#snippet cell(row, column)}
          {#if column.key === "startedAt"}
            {stamp(row.startedAt)}
          {:else if column.key === "status"}
            <Chip tone={runStatusTone(row.status)}>{runStatusLabel(row.status)}</Chip>
          {:else if column.key === "created"}
            {row.created}
          {:else if column.key === "cancelled"}
            {row.cancelled}
          {:else if column.key === "unmapped"}
            {row.unmapped}
          {:else if column.key === "skippedVocationalSchool"}
            {row.skippedVocationalSchool ?? 0}
          {:else if column.key === "replaced"}
            {row.replaced ?? 0}
          {/if}
        {/snippet}
      </DataTable>
      <Pagination
        total={runsTotal}
        bind:page
        bind:pageSize
        labelSingular="Lauf"
        labelPlural="Läufe"
        onChange={() => loadRuns()}
      />
    </section>
  {/if}
{/if}

<style>
  .ps-range {
    display: grid;
    grid-template-columns: repeat(2, minmax(0, 1fr));
    gap: var(--s-4);
    max-width: 44rem;
  }

  .ps-hint {
    margin: var(--s-2) 0 0;
    font-size: var(--fs-sm);
    color: var(--text-2);
  }

  .ps-actions {
    margin-top: var(--s-4);
  }

  .ps-run-head {
    display: flex;
    align-items: center;
    flex-wrap: wrap;
    gap: var(--s-3);
    margin: 0 0 var(--s-3);
  }

  .ps-run-time {
    font-size: var(--fs-sm);
    color: var(--text-2);
  }

  @media (max-width: 640px) {
    .ps-range {
      grid-template-columns: minmax(0, 1fr);
    }
  }
</style>

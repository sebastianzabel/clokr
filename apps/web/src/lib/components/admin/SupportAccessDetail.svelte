<!--
  SupportAccessDetail — one support access with every read made under it (Issue #93, AC-93-7, D-08,
  D-13; rebuilt on the blocks in #854) and the action that ends a running access at once.

  Display only: the page fetches and performs the end; this component shows what it is given and asks
  for the confirmation. Instants are written in the tenant's time zone from the API. The „Zugriff
  beenden“ button is a UX gate on `tenant-settings:update` — the API's 403 stays the authority. A read
  of an anonymised person names no one (D-13). The operator is shown by display name only, never an
  e-mail or an IP (T-854-64). The operator's reason is rendered as text, never markup.

  Props:
    detail — the API's detail response (`access`, `reads`, `timezone`)
    user   — the signed-in user (only its permissions are read)
    onEnd  — ends the access; a rejection keeps the dialog open and shows its message
-->
<script lang="ts">
  import Chip from "$components/ui/Chip.svelte";
  import ConfirmDialog from "$components/ui/ConfirmDialog.svelte";
  import DataTable, { type DataTableColumn } from "$components/ui/DataTable.svelte";
  import Note from "$components/ui/Note.svelte";
  import { hasPermission, type PermissionHolder } from "$lib/permissions";
  import {
    categoryLabel,
    endedByLabel,
    formatInZone,
    formatMonth,
    formatReadWindow,
    statusChipTone,
    statusLabel,
    type SupportAccessDetailResponse,
    type SupportAccessRead,
  } from "$lib/support-access/labels";

  interface Props {
    detail: SupportAccessDetailResponse;
    user: PermissionHolder | null;
    onEnd: () => Promise<void>;
  }

  let { detail, user, onEnd }: Props = $props();

  const access = $derived(detail.access);
  const timezone = $derived(detail.timezone);
  const canEnd = $derived(
    access.status === "ACTIVE" && hasPermission(user, "tenant-settings:update:ZUGEWIESEN"),
  );

  let confirmOpen = $state(false);
  let endError = $state("");

  /** Label and instant of the row that closes the window of the access. */
  const closing = $derived.by(() => {
    if (access.status === "ENDED") return { label: "Beendet am", at: access.endedAt };
    if (access.status === "EXPIRED") return { label: "Abgelaufen am", at: access.expiresAt };
    return { label: "Läuft ab am", at: access.expiresAt };
  });

  function openConfirm() {
    endError = "";
    confirmOpen = true;
  }

  async function confirmEnd() {
    endError = "";
    try {
      await onEnd();
    } catch (e: unknown) {
      endError = e instanceof Error ? e.message : "Der Zugriff konnte nicht beendet werden.";
      // ConfirmDialog keeps itself open when the confirm handler rejects.
      throw e;
    }
  }

  function personLabel(read: SupportAccessRead): string {
    if (read.employee === null) return "—";
    if (read.employee.anonymized) return "Gelöschte Person";
    return read.employee.name ?? "Person nicht mehr vorhanden";
  }

  function scopeLabel(read: SupportAccessRead): string {
    return formatMonth(read.month) || formatReadWindow(read.filters);
  }

  const readColumns: DataTableColumn[] = [
    { key: "at", label: "Zeitpunkt", primary: true },
    { key: "what", label: "Was" },
    { key: "person", label: "Person" },
    { key: "scope", label: "Zeitraum" },
  ];

  const readRows = $derived(
    detail.reads.map((read, index) => ({
      index,
      at: formatInZone(read.at, timezone),
      what: categoryLabel(read.category),
      person: personLabel(read),
      scope: scopeLabel(read),
    })),
  );
</script>

<section class="settings-group" aria-labelledby="sa-grant-title">
  <div class="sa-head">
    <div class="sa-head-text">
      <h2 class="settings-group-title" id="sa-grant-title">Freigabe</h2>
      <p class="settings-group-desc">
        Wer wann und warum auf die Daten deines Unternehmens zugegriffen hat
      </p>
    </div>
    {#if canEnd}
      <button type="button" class="btn btn-danger" onclick={openConfirm}>Zugriff beenden</button>
    {/if}
  </div>

  <dl class="sa-dl">
    <div>
      <dt>Betreiber</dt>
      <dd>{access.operatorName}</dd>
    </div>
    <div>
      <dt>Status</dt>
      <dd>
        <Chip tone={statusChipTone(access.status)}>{statusLabel(access.status)}</Chip>
      </dd>
    </div>
    <div>
      <dt>Beginn</dt>
      <dd>{formatInZone(access.startedAt, timezone)}</dd>
    </div>
    <div>
      <dt>{closing.label}</dt>
      <dd>{formatInZone(closing.at, timezone)}</dd>
    </div>
    {#if access.endedBy}
      <div>
        <dt>Beendet</dt>
        <dd>{endedByLabel(access.endedBy)}</dd>
      </div>
    {/if}
    <div class="sa-wide">
      <dt>Grund</dt>
      <dd class="sa-reason">{access.reason}</dd>
    </div>
  </dl>
</section>

<section class="settings-group" aria-labelledby="sa-reads-title">
  <h2 class="settings-group-title" id="sa-reads-title">Gelesene Daten</h2>
  <p class="settings-group-desc">
    Jeder einzelne Abruf unter diesem Zugriff, in der Reihenfolge des Abrufs
  </p>
  {#if detail.reads.length === 0}
    <Note tone="info">Noch keine Abrufe.</Note>
  {:else}
    <DataTable
      columns={readColumns}
      rows={readRows}
      rowKey={(row) => row.index}
      caption="Abrufe unter diesem Support-Zugriff"
    />
  {/if}
</section>

<ConfirmDialog
  bind:open={confirmOpen}
  danger
  title="Support-Zugriff beenden?"
  description="Der Betreiber verliert den Zugriff sofort. Für eine weitere Einsicht muss er einen neuen Zugriff mit Begründung anfordern."
  confirmLabel="Zugriff beenden"
  onConfirm={confirmEnd}
>
  {#snippet body()}
    {#if endError}
      <div role="alert"><Note tone="bad">{endError}</Note></div>
    {/if}
  {/snippet}
</ConfirmDialog>

<style>
  .sa-head {
    display: flex;
    flex-wrap: wrap;
    align-items: flex-start;
    justify-content: space-between;
    gap: var(--s-3);
  }

  .sa-head-text {
    display: flex;
    flex-direction: column;
    gap: var(--s-1);
    min-width: 0;
  }

  /* Each pair is one cell of a responsive grid: no breakpoint, the columns follow the available width. */
  .sa-dl {
    display: grid;
    grid-template-columns: repeat(auto-fill, minmax(min(100%, 14rem), 1fr));
    gap: var(--s-4);
    margin: 0;
  }

  .sa-dl > div {
    display: flex;
    flex-direction: column;
    gap: var(--s-1);
    min-width: 0;
  }

  .sa-wide {
    grid-column: 1 / -1;
  }

  .sa-dl dt {
    color: var(--text-2);
    font-size: var(--fs-sm);
    font-weight: 600;
  }

  .sa-dl dd {
    margin: 0;
    color: var(--text);
    min-width: 0;
  }

  .sa-reason {
    overflow-wrap: anywhere;
    white-space: pre-wrap;
  }
</style>

<!--
  SupportAccessDetail — one support access with every read made under it (Issue #93, AC-93-7, D-08,
  D-13) and the action that ends a running access at once.

  Display only: the page fetches and performs the end; this component shows what it is given and asks
  for the confirmation. Instants are written in the tenant's time zone from the API. The „Zugriff
  beenden“ button is a UX gate on `tenant-settings:update` — the API's 403 stays the authority. A read
  of an anonymised person names no one (D-13). The operator's reason is rendered as text, never markup.

  Props:
    detail — the API's detail response (`access`, `reads`, `timezone`)
    user   — the signed-in user (only its permissions are read)
    onEnd  — ends the access; a rejection keeps the dialog open and shows its message
-->
<script lang="ts">
  import ConfirmDialog from "$components/ui/ConfirmDialog.svelte";
  import Section from "$lib/components/admin/Section.svelte";
  import { hasPermission, type PermissionHolder } from "$lib/permissions";
  import {
    categoryLabel,
    endedByLabel,
    formatInZone,
    formatMonth,
    formatReadWindow,
    statusBadgeClass,
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
</script>

<Section title="Zugriff" sub="Wer wann und warum auf Ihre Daten zugegriffen hat">
  {#snippet actions()}
    {#if canEnd}
      <button class="btn btn-danger sm" type="button" onclick={openConfirm}>Zugriff beenden</button>
    {/if}
  {/snippet}

  <dl class="sa-dl">
    <dt>Betreiber</dt>
    <dd>{access.operatorName}</dd>

    <dt>Grund</dt>
    <dd class="sa-reason">{access.reason}</dd>

    <dt>Beginn</dt>
    <dd>{formatInZone(access.startedAt, timezone)}</dd>

    <dt>{closing.label}</dt>
    <dd>{formatInZone(closing.at, timezone)}</dd>

    <dt>Status</dt>
    <dd>
      <span class={`${statusBadgeClass(access.status)} sa-badge`}>{statusLabel(access.status)}</span
      >
    </dd>

    {#if access.endedBy}
      <dt>Beendet</dt>
      <dd>{endedByLabel(access.endedBy)}</dd>
    {/if}
  </dl>
</Section>

<Section
  title="Abrufe"
  sub="Jeder einzelne Abruf unter diesem Zugriff, in der Reihenfolge des Abrufs"
>
  {#if detail.reads.length === 0}
    <p class="sa-empty">Noch keine Abrufe.</p>
  {:else}
    <ul class="sa-reads" aria-label="Abrufe">
      {#each detail.reads as read, index (index)}
        <li class="sa-read">
          <span class="sa-read-time">{formatInZone(read.at, timezone)}</span>
          <span class="chip">{categoryLabel(read.category)}</span>
          <span class="sa-read-person">{personLabel(read)}</span>
          <span class="sa-read-scope">{scopeLabel(read)}</span>
        </li>
      {/each}
    </ul>
  {/if}
</Section>

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
      <div class="alert alert-error" role="alert"><span>⚠</span><span>{endError}</span></div>
    {/if}
  {/snippet}
</ConfirmDialog>

<style>
  /* The tinted label text of .badge-yellow / .badge-purple misses 4.5:1 on its own tint (measured 4.25:1 in
     light and down to 1.93:1 in dark mode): the label takes the body text colour, tint and border stay. */
  .sa-badge {
    color: var(--text);
  }

  .sa-dl {
    display: grid;
    grid-template-columns: max-content minmax(0, 1fr);
    gap: 8px 20px;
    margin: 0;
    font-size: 14px;
  }

  .sa-dl dt {
    color: var(--text-muted);
  }

  .sa-dl dd {
    margin: 0;
    min-width: 0;
  }

  .sa-reason {
    overflow-wrap: anywhere;
    white-space: pre-wrap;
  }

  .sa-empty {
    margin: 0;
    font-size: 14px;
    color: var(--text-muted);
  }

  .sa-reads {
    list-style: none;
    margin: 0;
    padding: 0;
    display: flex;
    flex-direction: column;
  }

  .sa-read {
    display: grid;
    grid-template-columns: max-content max-content minmax(0, 1fr) minmax(0, 1fr);
    align-items: center;
    gap: 12px;
    padding: 10px 0;
    border-bottom: 1px solid var(--border);
    font-size: 14px;
  }

  .sa-read:last-child {
    border-bottom: none;
  }

  .sa-read-time {
    font-variant-numeric: tabular-nums;
  }

  .sa-read-person,
  .sa-read-scope {
    overflow-wrap: anywhere;
  }

  .sa-read-scope {
    color: var(--text-muted);
  }

  @media (max-width: 720px) {
    .sa-dl {
      grid-template-columns: minmax(0, 1fr);
      gap: 2px;
    }

    .sa-dl dd {
      margin-bottom: 8px;
    }

    .sa-read {
      grid-template-columns: minmax(0, 1fr) max-content;
    }

    .sa-read-person,
    .sa-read-scope {
      grid-column: 1 / -1;
    }
  }
</style>

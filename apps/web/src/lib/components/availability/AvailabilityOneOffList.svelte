<script lang="ts">
  // Phase 46 — date-specific availability list with Pagination, inline edit,
  // and destructive delete. Used by both /availability (MA-Self-Service) and
  // /admin/availability (Admin) pages.

  import Modal from "$components/ui/Modal.svelte";
  import Pagination from "$components/ui/Pagination.svelte";
  import AvailabilityStatusPill from "./AvailabilityStatusPill.svelte";
  import AvailabilityEditModal, {
    type AvailabilityEntryDraft,
  } from "./AvailabilityEditModal.svelte";

  type Status = "AVAILABLE" | "UNAVAILABLE" | "PREFERRED";

  export interface OneOffEntry {
    id?: string;
    date: string;
    status: Status;
    note?: string | null;
    validFrom: string;
    validUntil?: string | null;
  }

  interface Props {
    entries: OneOffEntry[];
    disabled?: boolean;
  }

  let { entries = $bindable([]), disabled = false }: Props = $props();

  function todayISO(): string {
    return new Date().toISOString().slice(0, 10);
  }

  function formatDE(iso: string): string {
    // Local-only ISO date (YYYY-MM-DD) → DD.MM.YYYY without dragging in date-fns.
    if (!iso || iso.length < 10) return iso;
    const [y, m, d] = iso.slice(0, 10).split("-");
    return `${d}.${m}.${y}`;
  }

  // ── Sorted view ─────────────────────────────────────────────────────
  const sorted = $derived([...entries].sort((a, b) => a.date.localeCompare(b.date)));

  // ── Pagination ──────────────────────────────────────────────────────
  let page = $state(1);
  let pageSize = $state(10);
  const pagedEntries = $derived(
    sorted.slice((page - 1) * pageSize, (page - 1) * pageSize + pageSize),
  );

  // ── Edit modal state ────────────────────────────────────────────────
  let editOpen = $state(false);
  let editTargetIdx = $state<number | null>(null);
  let editInitial = $state<AvailabilityEntryDraft | undefined>(undefined);

  function openAdd() {
    if (disabled) return;
    editTargetIdx = null;
    editInitial = {
      dayOfWeek: null,
      date: todayISO(),
      status: "AVAILABLE",
      note: null,
      validFrom: todayISO(),
      validUntil: null,
    };
    editOpen = true;
  }

  function openEdit(entry: OneOffEntry) {
    if (disabled) return;
    const idx = entries.findIndex(
      (e) => e === entry || (e.id && e.id === entry.id) || e.date === entry.date,
    );
    editTargetIdx = idx >= 0 ? idx : null;
    editInitial = {
      dayOfWeek: null,
      date: entry.date,
      status: entry.status,
      note: entry.note ?? null,
      validFrom: entry.validFrom,
      validUntil: entry.validUntil ?? null,
    };
    editOpen = true;
  }

  function handleEditSave(draft: AvailabilityEntryDraft) {
    if (!draft.date) return;
    const next: OneOffEntry = {
      id: editTargetIdx != null ? entries[editTargetIdx]?.id : undefined,
      date: draft.date,
      status: draft.status,
      note: draft.note ?? null,
      validFrom: draft.validFrom,
      validUntil: draft.validUntil ?? null,
    };
    if (editTargetIdx != null) {
      entries = entries.map((e, i) => (i === editTargetIdx ? next : e));
    } else {
      entries = [...entries, next];
    }
    editOpen = false;
    editTargetIdx = null;
  }

  function handleEditCancel() {
    editOpen = false;
    editTargetIdx = null;
  }

  // ── Destructive confirm ─────────────────────────────────────────────
  let confirmOpen = $state(false);
  let confirmTarget = $state<OneOffEntry | null>(null);

  function askRemove(entry: OneOffEntry) {
    if (disabled) return;
    confirmTarget = entry;
    confirmOpen = true;
  }

  function doRemove() {
    if (!confirmTarget) return;
    const target = confirmTarget;
    entries = entries.filter(
      (e) => !(e === target || (e.id && e.id === target.id) || e.date === target.date),
    );
    confirmOpen = false;
    confirmTarget = null;
  }

  function cancelRemove() {
    confirmOpen = false;
    confirmTarget = null;
  }
</script>

<div class="av-oneoff-head">
  <button type="button" class="btn btn-secondary btn-sm" {disabled} onclick={openAdd}>
    + Einmaltermin hinzufügen
  </button>
</div>

{#if sorted.length === 0}
  <p class="av-empty">Keine Einmaltermine vorhanden.</p>
{:else}
  <div class="table-scroll">
    <table class="av-oneoff-table">
      <thead>
        <tr>
          <th scope="col">Datum</th>
          <th scope="col">Status</th>
          <th scope="col">Gültig bis</th>
          <th scope="col">Notiz</th>
          <th scope="col" class="av-col-action">Aktion</th>
        </tr>
      </thead>
      <tbody>
        {#each pagedEntries as entry (entry.id ?? entry.date)}
          <tr>
            <td class="mono">{formatDE(entry.date)}</td>
            <td>
              <AvailabilityStatusPill status={entry.status} />
            </td>
            <td class="mono">{entry.validUntil ? formatDE(entry.validUntil) : "—"}</td>
            <td class="av-note">{entry.note ?? ""}</td>
            <td class="av-col-action">
              <button
                type="button"
                class="btn btn-ghost btn-sm"
                {disabled}
                onclick={() => openEdit(entry)}
              >
                Bearbeiten
              </button>
              <button
                type="button"
                class="btn btn-ghost btn-sm"
                {disabled}
                onclick={() => askRemove(entry)}
              >
                Entfernen
              </button>
            </td>
          </tr>
        {/each}
      </tbody>
    </table>
  </div>
  {#if sorted.length > 10}
    <Pagination
      total={sorted.length}
      bind:page
      bind:pageSize
      labelSingular="Eintrag"
      labelPlural="Einträge"
    />
  {/if}
{/if}

<AvailabilityEditModal
  bind:open={editOpen}
  mode="oneoff"
  initial={editInitial}
  onsave={handleEditSave}
  oncancel={handleEditCancel}
/>

{#if confirmOpen}
  <div role="alertdialog" aria-modal="true" aria-label="Eintrag entfernen?">
    <Modal bind:open={confirmOpen} title="Eintrag entfernen?">
      <p>
        Dieser Verfügbarkeits-Eintrag wird dauerhaft gelöscht. Vorhandene Schichten bleiben
        unverändert.
      </p>
      <div class="modal-actions">
        <button type="button" class="btn btn-secondary" onclick={cancelRemove}>Abbrechen</button>
        <button type="button" class="btn btn-danger" onclick={doRemove}>Entfernen</button>
      </div>
    </Modal>
  </div>
{/if}

<style>
  .av-oneoff-head {
    margin-bottom: var(--s-3);
  }

  .av-empty {
    color: var(--text-muted);
    font-size: 0.9375rem;
    margin: 0;
  }

  .av-oneoff-table {
    width: 100%;
    border-collapse: collapse;
    font-size: 0.9375rem;
  }

  .av-oneoff-table th,
  .av-oneoff-table td {
    text-align: left;
    padding: var(--s-2) var(--s-3);
    border-bottom: 1px solid var(--border);
    vertical-align: middle;
  }

  .av-oneoff-table th {
    font-family: var(--font-sans);
    font-size: 11px;
    font-weight: 600;
    letter-spacing: 0.06em;
    text-transform: uppercase;
    color: var(--text-muted);
  }

  .mono {
    font-family: var(--font-mono);
    font-size: 13px;
    font-weight: 600;
    color: var(--text);
  }

  .av-note {
    max-width: 200px;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    color: var(--text);
  }

  .av-col-action {
    width: 1%;
    white-space: nowrap;
    display: flex;
    gap: var(--s-1);
    justify-content: flex-end;
    align-items: center;
  }

  /* Header cell mirrors the body alignment */
  th.av-col-action {
    text-align: right;
  }

  .modal-actions {
    display: flex;
    justify-content: flex-end;
    gap: var(--s-2);
    margin-top: var(--s-4);
  }
</style>

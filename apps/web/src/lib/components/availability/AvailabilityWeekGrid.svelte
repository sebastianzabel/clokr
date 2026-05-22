<script lang="ts">
  // Phase 46 — 7-row recurring weekly availability grid.
  // One row per dayOfWeek (Mo, Di, Mi, Do, Fr, Sa, So). Each row contains a
  // radiogroup of three AvailabilityStatusPill buttons (AVAILABLE / UNAVAILABLE /
  // PREFERRED) plus actions to edit details or delete the entry.
  //
  // Per CLAUDE.md UI Consistency Rules: per-page scoped overrides of the global
  // calendar recipe are forbidden — this component uses a local av-recurring-row
  // class instead. See app.css for the canonical calendar styles.

  import Modal from "$components/ui/Modal.svelte";
  import SegmentedControl from "$lib/components/ui/SegmentedControl.svelte";
  import AvailabilityEditModal, {
    type AvailabilityEntryDraft,
  } from "./AvailabilityEditModal.svelte";

  type Status = "AVAILABLE" | "UNAVAILABLE" | "PREFERRED";

  export interface RecurringEntry {
    id?: string;
    dayOfWeek: number;
    status: Status;
    note?: string | null;
    validFrom?: string;
    validUntil?: string | null;
  }

  interface Props {
    entries: RecurringEntry[];
    disabled?: boolean;
  }

  let { entries = $bindable([]), disabled = false }: Props = $props();

  // Display order: Monday-first (1..6, 0 for Sunday last) to match German week.
  const WEEK = [
    { dow: 1, short: "Mo", long: "Montag" },
    { dow: 2, short: "Di", long: "Dienstag" },
    { dow: 3, short: "Mi", long: "Mittwoch" },
    { dow: 4, short: "Do", long: "Donnerstag" },
    { dow: 5, short: "Fr", long: "Freitag" },
    { dow: 6, short: "Sa", long: "Samstag" },
    { dow: 0, short: "So", long: "Sonntag" },
  ];

  function todayISO(): string {
    return new Date().toISOString().slice(0, 10);
  }

  function entryFor(dow: number): RecurringEntry | undefined {
    return entries.find((e) => e.dayOfWeek === dow);
  }

  function setStatus(dow: number, status: Status) {
    if (disabled) return;
    const idx = entries.findIndex((e) => e.dayOfWeek === dow);
    if (idx >= 0) {
      entries = entries.map((e, i) => (i === idx ? { ...e, status } : e));
    } else {
      entries = [
        ...entries,
        { dayOfWeek: dow, status, note: null, validFrom: todayISO(), validUntil: null },
      ];
    }
  }

  // ── Edit modal state ────────────────────────────────────────────────
  let editOpen = $state(false);
  let editTargetDow = $state<number | null>(null);
  let editInitial = $state<AvailabilityEntryDraft | undefined>(undefined);

  function openEdit(dow: number) {
    if (disabled) return;
    const existing = entryFor(dow);
    editTargetDow = dow;
    editInitial = {
      dayOfWeek: dow,
      date: null,
      status: existing?.status ?? "AVAILABLE",
      note: existing?.note ?? null,
      validFrom: existing?.validFrom ?? todayISO(),
      validUntil: existing?.validUntil ?? null,
    };
    editOpen = true;
  }

  function handleEditSave(draft: AvailabilityEntryDraft) {
    if (editTargetDow == null) return;
    const dow = editTargetDow;
    const idx = entries.findIndex((e) => e.dayOfWeek === dow);
    const next: RecurringEntry = {
      id: entries[idx]?.id,
      dayOfWeek: dow,
      status: draft.status,
      note: draft.note ?? null,
      validFrom: draft.validFrom,
      validUntil: draft.validUntil ?? null,
    };
    if (idx >= 0) {
      entries = entries.map((e, i) => (i === idx ? next : e));
    } else {
      entries = [...entries, next];
    }
    editOpen = false;
    editTargetDow = null;
  }

  function handleEditCancel() {
    editOpen = false;
    editTargetDow = null;
  }

  // ── Destructive confirm ─────────────────────────────────────────────
  let confirmOpen = $state(false);
  let confirmTargetDow = $state<number | null>(null);

  function askRemove(dow: number) {
    if (disabled) return;
    confirmTargetDow = dow;
    confirmOpen = true;
  }

  function doRemove() {
    if (confirmTargetDow == null) return;
    entries = entries.filter((e) => e.dayOfWeek !== confirmTargetDow);
    confirmOpen = false;
    confirmTargetDow = null;
  }

  function cancelRemove() {
    confirmOpen = false;
    confirmTargetDow = null;
  }

  function borderColor(status: Status | undefined): string {
    if (status === "AVAILABLE") return "var(--good)";
    if (status === "UNAVAILABLE") return "var(--bad)";
    if (status === "PREFERRED") return "var(--brand)";
    return "transparent";
  }

  const STATUS_OPTIONS = [
    { value: "AVAILABLE", label: "Verfügbar", glyph: "✓" },
    { value: "UNAVAILABLE", label: "Nicht verfügbar", glyph: "✕" },
    { value: "PREFERRED", label: "Bevorzugt", glyph: "★" },
  ];
</script>

{#if entries.length === 0}
  <p class="av-empty">Noch keine wöchentliche Verfügbarkeit hinterlegt.</p>
{/if}

<div class="av-recurring-rows">
  {#each WEEK as day (day.dow)}
    {@const entry = entryFor(day.dow)}
    <div class="av-recurring-row" style="border-left-color: {borderColor(entry?.status)};">
      <span class="av-dow" aria-label={day.long}>{day.short}</span>

      <SegmentedControl
        options={STATUS_OPTIONS}
        value={entry?.status ?? ""}
        name="av-status-{day.dow}"
        ariaLabel="Status für {day.long}"
        size="sm"
        {disabled}
        onchange={(v) => setStatus(day.dow, v as Status)}
      />

      <div class="av-actions">
        <button
          type="button"
          class="btn btn-ghost btn-sm"
          {disabled}
          onclick={() => openEdit(day.dow)}
        >
          Notiz
        </button>
        <button
          type="button"
          class="btn btn-icon btn-ghost"
          aria-label="Eintrag für {day.long} entfernen"
          disabled={disabled || !entry}
          onclick={() => askRemove(day.dow)}
        >
          🗑
        </button>
      </div>
    </div>
  {/each}
</div>

<AvailabilityEditModal
  bind:open={editOpen}
  mode="recurring"
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
  .av-empty {
    color: var(--text-muted);
    font-size: 0.9375rem;
    margin: 0 0 var(--s-3);
  }

  .av-recurring-rows {
    display: flex;
    flex-direction: column;
    gap: var(--s-1);
  }

  .av-recurring-row {
    display: grid;
    grid-template-columns: 48px 1fr auto;
    align-items: center;
    gap: var(--s-3);
    min-height: var(--row-h);
    padding: var(--s-2) var(--s-3);
    background: var(--bg-card);
    border: 1px solid var(--border);
    border-left: 3px solid transparent;
    border-radius: var(--r-md);
  }

  .av-dow {
    font-family: var(--font-sans);
    font-size: 11px;
    font-weight: 700;
    text-transform: uppercase;
    letter-spacing: 0.06em;
    color: var(--text);
  }

  .av-actions {
    display: flex;
    gap: var(--s-1);
    align-items: center;
  }

  .modal-actions {
    display: flex;
    justify-content: flex-end;
    gap: var(--s-2);
    margin-top: var(--s-4);
  }

  /* Mobile: stack control vertically (UI-SPEC §Mobile Behavior) */
  @media (max-width: 480px) {
    .av-recurring-row {
      grid-template-columns: 40px 1fr;
      grid-template-areas:
        "dow control"
        "dow actions";
    }
    .av-dow {
      grid-area: dow;
      align-self: start;
    }
    :global(.av-recurring-row .seg-control) {
      grid-area: control;
    }
    .av-actions {
      grid-area: actions;
      justify-content: flex-end;
    }
  }

  /* Touch devices: force 44px min hit target regardless of density (WCAG 2.5.5) */
  @media (pointer: coarse) {
    .av-recurring-row {
      min-height: 44px;
    }
  }
</style>

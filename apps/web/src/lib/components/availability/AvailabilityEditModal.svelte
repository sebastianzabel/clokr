<script lang="ts">
  // Phase 46 — modal wrapper for create / edit of a single EmployeeAvailability row.
  // Used by both AvailabilityWeekGrid (mode="recurring") and AvailabilityOneOffList
  // (mode="oneoff"). Wraps the existing $components/ui/Modal.svelte primitive
  // (role="dialog"; alertdialog is reserved for destructive confirms).

  import Modal from "$components/ui/Modal.svelte";
  import AvailabilityStatusPill from "./AvailabilityStatusPill.svelte";

  type Status = "AVAILABLE" | "UNAVAILABLE" | "PREFERRED";

  export interface AvailabilityEntryDraft {
    dayOfWeek?: number | null;
    date?: string | null;
    status: Status;
    note?: string | null;
    validFrom: string;
    validUntil?: string | null;
  }

  interface Props {
    open: boolean;
    mode: "recurring" | "oneoff";
    initial?: AvailabilityEntryDraft;
    onsave: (entry: AvailabilityEntryDraft) => void;
    oncancel: () => void;
  }

  let { open = $bindable(), mode, initial, onsave, oncancel }: Props = $props();

  // German weekday labels (verbatim per 46-UI-SPEC).
  const WEEKDAYS = [
    { value: 1, label: "Montag" },
    { value: 2, label: "Dienstag" },
    { value: 3, label: "Mittwoch" },
    { value: 4, label: "Donnerstag" },
    { value: 5, label: "Freitag" },
    { value: 6, label: "Samstag" },
    { value: 0, label: "Sonntag" },
  ];

  function todayISO(): string {
    return new Date().toISOString().slice(0, 10);
  }

  // Local form state — initialised on first open via the $effect below.
  // Re-sync runs every time the modal transitions to open=true so that
  // a parent can reuse the same modal instance for multiple edit targets.
  let dayOfWeek = $state<number>(1);
  let date = $state<string>(todayISO());
  let status = $state<Status>("AVAILABLE");
  let note = $state<string>("");
  let validFrom = $state<string>(todayISO());
  let validUntil = $state<string>("");

  // Resync local state whenever the modal is (re)opened with new `initial`.
  $effect(() => {
    if (open) {
      dayOfWeek = initial?.dayOfWeek ?? 1;
      date = initial?.date ?? todayISO();
      status = initial?.status ?? "AVAILABLE";
      note = initial?.note ?? "";
      validFrom = initial?.validFrom ?? todayISO();
      validUntil = initial?.validUntil ?? "";
    }
  });

  // Inline validation: validUntil must be >= validFrom when both set.
  // German quote chars („ ") taken verbatim from 46-UI-SPEC line 218.
  const rangeError = $derived(
    validUntil && validFrom && validUntil < validFrom
      ? `„Gültig bis" muss nach „Gültig ab" liegen.`
      : "",
  );

  const canSave = $derived(!rangeError && status !== undefined);

  function handleSave(e: Event) {
    e.preventDefault();
    if (!canSave) return;
    const entry: AvailabilityEntryDraft = {
      dayOfWeek: mode === "recurring" ? dayOfWeek : null,
      date: mode === "oneoff" ? date : null,
      status,
      note: note.trim() ? note.trim() : null,
      validFrom,
      validUntil: validUntil ? validUntil : null,
    };
    onsave(entry);
  }

  function handleCancel() {
    open = false;
    oncancel();
  }

  const title = $derived(mode === "recurring" ? "Wochentag bearbeiten" : "Einmaltermin bearbeiten");
</script>

<Modal bind:open eyebrow={mode === "recurring" ? "Wöchentlich" : "Einmalig"} {title}>
  <form class="av-edit-form" onsubmit={handleSave}>
    {#if mode === "recurring"}
      <div class="form-group">
        <label class="form-label" for="av-edit-dow">Wochentag</label>
        <select id="av-edit-dow" class="form-input" bind:value={dayOfWeek}>
          {#each WEEKDAYS as d (d.value)}
            <option value={d.value}>{d.label}</option>
          {/each}
        </select>
      </div>
    {:else}
      <div class="form-group">
        <label class="form-label" for="av-edit-date">Datum</label>
        <input id="av-edit-date" class="form-input" type="date" bind:value={date} />
      </div>
    {/if}

    <div class="form-group">
      <span class="form-label" id="av-edit-status-label">Status</span>
      <div
        class="av-pill-group"
        role="radiogroup"
        aria-labelledby="av-edit-status-label"
        aria-label="Status"
      >
        <AvailabilityStatusPill
          status="AVAILABLE"
          as="button"
          selected={status === "AVAILABLE"}
          onclick={() => (status = "AVAILABLE")}
        />
        <AvailabilityStatusPill
          status="UNAVAILABLE"
          as="button"
          selected={status === "UNAVAILABLE"}
          onclick={() => (status = "UNAVAILABLE")}
        />
        <AvailabilityStatusPill
          status="PREFERRED"
          as="button"
          selected={status === "PREFERRED"}
          onclick={() => (status = "PREFERRED")}
        />
      </div>
    </div>

    <div class="form-row">
      <div class="form-group">
        <label class="form-label" for="av-edit-valid-from">Gültig ab (optional)</label>
        <input
          id="av-edit-valid-from"
          class="form-input"
          type="date"
          bind:value={validFrom}
        />
      </div>
      <div class="form-group">
        <label class="form-label" for="av-edit-valid-until">Gültig bis (optional)</label>
        <input
          id="av-edit-valid-until"
          class="form-input"
          type="date"
          bind:value={validUntil}
        />
        {#if rangeError}
          <span class="form-error" role="alert" aria-live="polite">{rangeError}</span>
        {/if}
      </div>
    </div>

    <div class="form-group">
      <label class="form-label" for="av-edit-note">Notiz</label>
      <textarea
        id="av-edit-note"
        class="form-input"
        maxlength="200"
        rows="3"
        bind:value={note}
      ></textarea>
      <span class="form-hint">Optionale Notiz (max. 200 Zeichen)</span>
    </div>

    <div class="modal-actions">
      <button type="button" class="btn btn-secondary" onclick={handleCancel}>Abbrechen</button>
      <button type="submit" class="btn btn-primary" disabled={!canSave}>Speichern</button>
    </div>
  </form>
</Modal>

<style>
  .av-edit-form {
    display: flex;
    flex-direction: column;
    gap: var(--s-4);
  }

  .form-row {
    display: grid;
    grid-template-columns: 1fr 1fr;
    gap: var(--s-3);
  }

  @media (max-width: 480px) {
    .form-row {
      grid-template-columns: 1fr;
    }
  }

  .av-pill-group {
    display: flex;
    gap: var(--s-2);
    flex-wrap: wrap;
  }

  .modal-actions {
    display: flex;
    justify-content: flex-end;
    gap: var(--s-2);
    margin-top: var(--s-2);
  }
</style>

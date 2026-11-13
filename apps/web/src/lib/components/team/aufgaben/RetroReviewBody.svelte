<script lang="ts">
  // Issue #853 (D-853-08, D-853-09, D-853-18) - the Zeitnachtrag decision as a Dialog with a fact list.
  // Template only: the page owns the request, the PATCH call and the state; this component shows the
  // facts (Person, Tag, beantragte Zeiten, Grund der Person), the manager's edit-on-approve times
  // (Phase 96, RETRO-16/D-10) and the required reason, and calls back. Rejecting is impossible
  // without a trimmed reason (the button stays disabled), exactly like the leave and § 9 decisions.
  import Dialog from "$components/ui/Dialog.svelte";
  import FormField from "$components/ui/FormField.svelte";
  import Note from "$components/ui/Note.svelte";

  interface Props {
    /** Two-way bindable open state; the page owns the boolean. */
    open?: boolean;
    /** The employee the request is about. */
    personName: string;
    /** The day of the entry, already formatted (e.g. „30.10.2026“). */
    dayLabel: string;
    /** The proposed times as text (e.g. „09:30–18:15“), or null when none were proposed. */
    proposedLabel: string | null;
    /** How old the entry is, in days; null when the server did not say. */
    entryAgeInDays: number | null;
    /** The employee's reason, shown as the person wrote it. */
    employeeReason: string;
    /** A warning line when the entry lies outside the retro window; null = none. */
    ageWarning: string | null;
    /** The times are editable on approval only when times were proposed. */
    editableTimes: boolean;
    startTime: string;
    endTime: string;
    breakMinutes: number;
    /** The manager's reason: optional on approval, required on rejection. */
    reviewNote: string;
    saving?: boolean;
    /** An inline error of the last attempt (validation or server). */
    error?: string;
    /** The request is still open for a decision. */
    pending: boolean;
    /** The caller is the person of the request: no self-approval. */
    selfApproval?: boolean;
    onApprove: () => void;
    onReject: () => void;
    onCancel: () => void;
  }

  let {
    open = $bindable(false),
    personName,
    dayLabel,
    proposedLabel,
    entryAgeInDays,
    employeeReason,
    ageWarning,
    editableTimes,
    startTime = $bindable(""),
    endTime = $bindable(""),
    breakMinutes = $bindable(0),
    reviewNote = $bindable(""),
    saving = false,
    error = "",
    pending,
    selfApproval = false,
    onApprove,
    onReject,
    onCancel,
  }: Props = $props();

  const reasonMissing = $derived(!reviewNote.trim());
</script>

<Dialog bind:open eyebrow="Zeitnachtrag" title="Zeitnachtrag prüfen">
  <div data-testid="retro-review-dialog" style="display: contents">
    <dl class="facts" data-testid="retro-review-facts">
      <div class="fact">
        <dt>Person</dt>
        <dd>{personName}</dd>
      </div>
      <div class="fact">
        <dt>Tag</dt>
        <dd>{dayLabel}</dd>
      </div>
      {#if proposedLabel}
        <div class="fact">
          <dt>Beantragte Zeiten</dt>
          <dd>{proposedLabel}</dd>
        </div>
      {/if}
      <div class="fact">
        <dt>Alter des Eintrags</dt>
        <dd>{entryAgeInDays === null ? "?" : `${entryAgeInDays} Tage`}</dd>
      </div>
      <div class="fact fact--full">
        <dt>Grund der Person</dt>
        <dd>„{employeeReason}“</dd>
      </div>
    </dl>

    {#if editableTimes}
      <div class="review-section">
        <p class="section-title">Zeiten bei der Genehmigung anpassen</p>
        <div class="times-row">
          <FormField label="Von">
            {#snippet field({ id, describedBy, invalid })}
              <input
                {id}
                type="time"
                class="form-input"
                bind:value={startTime}
                disabled={saving}
                aria-describedby={describedBy}
                aria-invalid={invalid ? "true" : undefined}
              />
            {/snippet}
          </FormField>
          <FormField label="Bis">
            {#snippet field({ id, describedBy, invalid })}
              <input
                {id}
                type="time"
                class="form-input"
                bind:value={endTime}
                disabled={saving}
                aria-describedby={describedBy}
                aria-invalid={invalid ? "true" : undefined}
              />
            {/snippet}
          </FormField>
          <FormField label="Pause (Min.)">
            {#snippet field({ id, describedBy, invalid })}
              <input
                {id}
                type="number"
                min="0"
                step="1"
                class="form-input"
                bind:value={breakMinutes}
                disabled={saving}
                aria-describedby={describedBy}
                aria-invalid={invalid ? "true" : undefined}
              />
            {/snippet}
          </FormField>
        </div>
      </div>
    {/if}

    {#if ageWarning}
      <div class="review-section" role="alert">
        <Note tone="warn">{ageWarning}</Note>
      </div>
    {/if}

    <div class="review-section">
      <Note tone="info">
        Rückwirkende Korrekturen müssen revisionssicher begründet sein (ArbZG § 16 Abs. 2).
      </Note>
    </div>

    <div class="review-section">
      <FormField label="Begründung" help="Pflicht beim Ablehnen">
        {#snippet field({ id, describedBy, invalid })}
          <input
            {id}
            data-testid="retro-review-note"
            type="text"
            class="form-input"
            bind:value={reviewNote}
            placeholder="Begründung für Genehmigung oder Ablehnung"
            disabled={saving}
            aria-describedby={describedBy}
            aria-invalid={invalid ? "true" : undefined}
          />
        {/snippet}
      </FormField>
    </div>

    {#if error}
      <div class="review-section" role="alert">
        <Note tone="bad">{error}</Note>
      </div>
    {/if}
  </div>

  {#snippet footer()}
    <button type="button" class="btn btn-ghost" onclick={onCancel} disabled={saving}>
      Abbrechen
    </button>
    <span class="spacer"></span>
    {#if selfApproval}
      <span class="footer-note">Eigene Anträge können nicht selbst genehmigt werden.</span>
    {:else if pending}
      {#if reasonMissing}
        <span class="footer-note" id="retro-reason-hint">Bitte nenne einen Grund.</span>
      {/if}
      <button
        type="button"
        class="btn btn-secondary"
        data-testid="retro-review-reject"
        onclick={onReject}
        disabled={saving || reasonMissing}
        aria-describedby={reasonMissing ? "retro-reason-hint" : undefined}
      >
        {saving ? "…" : "Ablehnen"}
      </button>
      <button
        type="button"
        class="btn btn-primary"
        data-testid="retro-review-approve"
        onclick={onApprove}
        disabled={saving}
      >
        {saving ? "…" : "Genehmigen"}
      </button>
    {:else}
      <span class="footer-note">Antrag bereits entschieden.</span>
    {/if}
  {/snippet}
</Dialog>

<style>
  /* The facts are a plain definition list on the dialog surface, the same recipe as the leave dialog. */
  .facts {
    display: grid;
    grid-template-columns: 1fr 1fr;
    gap: var(--s-3) var(--s-6);
    margin: 0;
  }
  .fact {
    display: flex;
    flex-direction: column;
    gap: 2px;
    min-width: 0;
  }
  .fact--full {
    grid-column: 1 / -1;
  }
  .fact dt {
    font-size: var(--fs-sm);
    font-weight: 600;
    color: var(--text-2);
  }
  .fact dd {
    margin: 0;
    font-size: var(--fs-base);
    font-weight: 500;
    overflow-wrap: anywhere;
  }
  .review-section {
    margin-top: var(--s-5);
  }
  .section-title {
    margin: 0 0 var(--s-2);
    font-size: var(--fs-sm);
    font-weight: 600;
    color: var(--text-2);
  }
  .times-row {
    display: grid;
    grid-template-columns: repeat(3, minmax(0, 1fr));
    gap: var(--s-3);
  }
  .footer-note {
    font-size: var(--fs-sm);
    color: var(--text-2);
  }
  .spacer {
    flex: 1;
  }

  @media (max-width: 560px) {
    .facts {
      grid-template-columns: 1fr;
    }
    .times-row {
      grid-template-columns: 1fr;
    }
  }
</style>

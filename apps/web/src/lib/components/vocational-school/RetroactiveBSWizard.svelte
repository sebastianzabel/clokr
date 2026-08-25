<script lang="ts">
  // Phase 103 plan 04 — 3-step wizard replacing the plan-01 tracer's single-step
  // confirm dialog. Composed from Modal.svelte (no forked scrim/focus-trap/ESC
  // handling); every German sentence and every conflict/override rule is computed in
  // the pure sibling module `retroactive.ts` — this component renders, it does not
  // decide.
  //
  // Step 1 "Was ändert sich" is always shown. Step 2 "Bereits erfasste Zeiten" exists
  // only when the preview reports TimeEntry conflicts (D-02: two clicks in the clean
  // case, step 2 never enters the DOM). Step 3 "Bestätigen" is always the confirm
  // step; after a successful apply it swaps in-place to the server's real result
  // (D-01 — never a synthesised success message).
  import Modal from "$lib/components/ui/Modal.svelte";
  import Spinner from "$lib/components/ui/Spinner.svelte";
  import SegmentedControl from "$lib/components/ui/SegmentedControl.svelte";
  import {
    buildRetroactiveSummary,
    monthLabelsFromDetails,
    conflictDaysFromPreview,
    hasConflicts,
    effectiveOverrideDates,
    buildApplyResultText,
    formatIsoDateDe,
    type RetroactivePreview,
    type ConflictDay,
  } from "./retroactive";

  interface Props {
    /** Bindable open state. Parent owns the boolean (`$state(false)`). */
    open: boolean;
    /** The dry-run result the wizard renders and derives step 2's conflict list from. */
    preview: RetroactivePreview;
    /** Confirm handler — posts effectiveOverrideDates() and must return the REAL
     * server GeneratorResult (T-103-STALE: never a synthesised success message). */
    onConfirm: (overrideDates: string[]) => Promise<RetroactivePreview>;
    /** Fired on every close path (Abbrechen, ESC, backdrop, Schließen). */
    onClose?: () => void;
  }

  let { open = $bindable(), preview, onConfirm, onClose }: Props = $props();

  const TOGGLE_OPTIONS = [
    { value: "skip", label: "Überspringen" },
    { value: "apply", label: "Übernehmen" },
  ];

  let step = $state<1 | 2 | 3>(1);
  let conflicts = $state<ConflictDay[]>([]);
  let pending = $state(false);
  let result = $state<RetroactivePreview | null>(null);
  let error = $state("");
  let prevOpen = $state(open);

  // Re-initialise on every open transition. `conflictDaysFromPreview` defaults every
  // day to "skip" (D-07) — the wizard never pre-selects an override.
  $effect(() => {
    if (open) {
      step = 1;
      conflicts = conflictDaysFromPreview(preview);
      pending = false;
      result = null;
      error = "";
    }
  });

  // Modal.svelte sets open=false directly on ESC / backdrop click without invoking
  // any callback — observe the transition here so the parent's onClose fires on
  // every dismiss path uniformly (cancel, back-then-ESC, or the post-apply "Schließen").
  $effect(() => {
    if (prevOpen && !open) {
      onClose?.();
    }
    prevOpen = open;
  });

  let hasConflictStep = $derived(hasConflicts(preview));
  let totalSteps = $derived(hasConflictStep ? 3 : 2);
  // Step 2 only exists when there are conflicts, so on a conflict-free run the
  // internal step-3 confirm state is visually the SECOND step, not the third.
  let visibleStepNumber = $derived(!hasConflictStep && step === 3 ? 2 : step);
  let stepTitle = $derived(
    step === 1 ? "Was ändert sich" : step === 2 ? "Bereits erfasste Zeiten" : "Bestätigen",
  );

  let summaryText = $derived(buildRetroactiveSummary(preview));
  let lockedNote = $derived(monthLabelsFromDetails(preview.details));
  let overrideActive = $derived(conflicts.some((c) => c.disposition === "apply"));
  let skipCount = $derived(conflicts.filter((c) => c.disposition === "skip").length);
  let applyCount = $derived(conflicts.filter((c) => c.disposition === "apply").length);
  let resultText = $derived(result ? buildApplyResultText(result) : "");

  function next() {
    if (step === 1) {
      step = hasConflictStep ? 2 : 3;
    } else if (step === 2) {
      step = 3;
    }
  }

  function back() {
    if (step === 3) {
      step = hasConflictStep ? 2 : 1;
    } else if (step === 2) {
      step = 1;
    }
  }

  function handleCancel() {
    if (pending) return;
    open = false;
  }

  function setDisposition(date: string, disposition: "skip" | "apply") {
    conflicts = conflicts.map((c) => (c.date === date ? { ...c, disposition } : c));
  }

  function bulkSkip() {
    conflicts = conflicts.map((c) => ({ ...c, disposition: "skip" as const }));
  }

  function bulkApply() {
    conflicts = conflicts.map((c) => ({ ...c, disposition: "apply" as const }));
  }

  // T-103-REPLAY mitigation — copied verbatim from ConfirmDialog.svelte's guard.
  async function handleConfirm() {
    if (pending) return;
    pending = true;
    try {
      result = await onConfirm(effectiveOverrideDates(conflicts));
    } catch (e: unknown) {
      error =
        e instanceof Error ? e.message : "Rückwirkende Anpassung konnte nicht angewendet werden.";
    } finally {
      pending = false;
    }
  }

  function handleCloseResult() {
    open = false;
  }
</script>

<Modal
  bind:open
  eyebrow={`Schritt ${visibleStepNumber} von ${totalSteps}`}
  title={stepTitle}
  ariaLabel="Berufsschultage rückwirkend anpassen"
>
  <div data-testid="bs-retro-dialog">
    {#if step === 1}
      <div data-testid="bs-retro-step-1">
        <p data-testid="bs-retro-summary">{summaryText}</p>
        {#if lockedNote}
          <p data-testid="bs-retro-locked-note" class="locked-note">{lockedNote}</p>
        {/if}
        {#if hasConflictStep}
          <p data-testid="bs-retro-conflict-teaser" class="conflict-teaser">
            {conflicts.length} Tage haben bereits erfasste Arbeitszeit — im nächsten Schritt entscheiden.
          </p>
        {/if}
      </div>
    {:else if step === 2}
      <div data-testid="bs-retro-step-2">
        <p class="conflict-intro">
          An diesen Tagen ist bereits Arbeitszeit erfasst. Ein Berufsschultag würde die Gutschrift
          nach § 15 BBiG zusätzlich zur erfassten Zeit anrechnen.
        </p>
        <div class="bulk-row">
          <button
            class="btn btn-ghost"
            type="button"
            data-testid="bs-retro-bulk-skip"
            onclick={bulkSkip}
          >
            Alle überspringen
          </button>
          <button
            class="btn btn-ghost"
            type="button"
            data-testid="bs-retro-bulk-apply"
            onclick={bulkApply}
          >
            Alle übernehmen
          </button>
        </div>
        <ul class="conflict-list">
          {#each conflicts as c (c.date)}
            <li class="conflict-row" data-testid="bs-retro-conflict-row-{c.date}">
              <span class="conflict-day">
                <span class="conflict-weekday">{c.weekdayLabel}</span>
                <span class="conflict-date">{formatIsoDateDe(c.date)}</span>
              </span>
              <span data-testid="bs-retro-conflict-toggle-{c.date}">
                <SegmentedControl
                  size="sm"
                  ariaLabel="Entscheidung für {formatIsoDateDe(c.date)}"
                  options={TOGGLE_OPTIONS}
                  value={c.disposition}
                  onchange={(v) => setDisposition(c.date, v === "apply" ? "apply" : "skip")}
                />
              </span>
            </li>
          {/each}
        </ul>
        {#if overrideActive}
          <p data-testid="bs-retro-override-warning" class="override-warning">
            An übernommenen Tagen zählen erfasste Zeit und Berufsschul-Gutschrift zusammen.
          </p>
        {/if}
      </div>
    {:else if step === 3}
      <div data-testid="bs-retro-step-3">
        {#if result}
          <p data-testid="bs-retro-result">{resultText}</p>
        {:else}
          <p data-testid="bs-retro-confirm-summary">{summaryText}</p>
          {#if lockedNote}
            <p data-testid="bs-retro-locked-note" class="locked-note">{lockedNote}</p>
          {/if}
          {#if hasConflictStep}
            <p data-testid="bs-retro-confirm-conflict-summary">
              {skipCount}
              {skipCount === 1 ? "Tag wird übersprungen" : "Tage werden übersprungen"}, {applyCount}
              {applyCount === 1 ? "Tag wird übernommen" : "Tage werden übernommen"}.
            </p>
          {/if}
          {#if error}
            <p class="callout error">{error}</p>
          {/if}
        {/if}
      </div>
    {/if}
  </div>

  {#snippet footer()}
    {#if step === 1}
      <button
        class="btn btn-ghost"
        type="button"
        data-testid="bs-retro-cancel"
        onclick={handleCancel}
      >
        Abbrechen
      </button>
      <button class="btn btn-primary" type="button" data-testid="bs-retro-next" onclick={next}>
        Weiter
      </button>
    {:else if step === 2}
      <button class="btn btn-ghost" type="button" data-testid="bs-retro-back" onclick={back}>
        Zurück
      </button>
      <button class="btn btn-primary" type="button" data-testid="bs-retro-next" onclick={next}>
        Weiter
      </button>
    {:else if step === 3 && !result}
      <button
        class="btn btn-ghost"
        type="button"
        data-testid="bs-retro-back"
        onclick={back}
        disabled={pending}
      >
        Zurück
      </button>
      <button
        class="btn btn-primary"
        type="button"
        data-testid="bs-retro-confirm"
        onclick={handleConfirm}
        disabled={pending}
      >
        {#if pending}<Spinner />{/if}
        Jetzt anwenden
      </button>
    {:else if step === 3 && result}
      <button
        class="btn btn-primary"
        type="button"
        data-testid="bs-retro-close"
        onclick={handleCloseResult}
      >
        Schließen
      </button>
    {/if}
  {/snippet}
</Modal>

<style>
  .locked-note,
  .conflict-teaser,
  .conflict-intro {
    margin: var(--s-3) 0 0;
    font-size: 14px;
    line-height: 1.55;
    color: var(--text-muted);
  }

  .bulk-row {
    display: flex;
    gap: var(--s-2);
    margin-top: var(--s-4);
  }

  .conflict-list {
    list-style: none;
    margin: var(--s-3) 0 0;
    padding: 0;
    display: flex;
    flex-direction: column;
    gap: var(--s-2);
  }

  .conflict-row {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: var(--s-3);
    padding: var(--s-2) var(--s-3);
    background: var(--bg-subtle);
    border: 1px solid var(--border);
    border-radius: var(--r-md);
  }

  .conflict-day {
    display: flex;
    align-items: baseline;
    gap: var(--s-2);
    font-size: 14px;
  }

  .conflict-weekday {
    font-weight: 600;
    color: var(--text);
  }

  .conflict-date {
    color: var(--text-muted);
  }

  .override-warning {
    margin: var(--s-4) 0 0;
    padding: var(--s-3);
    background: var(--warn-soft);
    border: 1.5px solid var(--warn-soft);
    border-radius: var(--r-md);
    color: var(--warn);
    font-size: 13px;
    line-height: 1.5;
  }

  .callout.error {
    margin: var(--s-3) 0 0;
    color: var(--bad);
    font-size: 14px;
  }
</style>

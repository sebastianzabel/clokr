<script lang="ts">
  // Issue #599 (Phase 851, prototype): the correction request for a day of a closed month. The person names
  // the times they want and a reason; the request goes to their leadership, and an approval is booked in
  // the running month - the closed month stays as it is (API #902, Arbeitszeitkonto). No field is focused
  // before the person chooses one; the reason is required (10 to 1000 characters, as the API checks).
  import Dialog from "$components/ui/Dialog.svelte";
  import FormField from "$components/ui/FormField.svelte";
  import Note from "$components/ui/Note.svelte";
  import Spinner from "$components/ui/Spinner.svelte";
  import { toasts } from "$stores/toast";
  import {
    createMonthCorrection,
    refusalCode,
    type MonthCorrection,
  } from "$lib/me/month-corrections";

  interface Props {
    open: boolean;
    /** YYYY-MM-DD */
    day: string;
    dayLabel: string;
    /** Prefill from the recorded day, "HH:MM" or "". */
    initialStart?: string;
    initialEnd?: string;
    initialBreak?: number;
    onCreated: (request: MonthCorrection) => void;
    /** The day's month is not closed: offer the ordinary edit instead. */
    onMonthOpen?: () => void;
  }

  let {
    open = $bindable(),
    day,
    dayLabel,
    initialStart = "",
    initialEnd = "",
    initialBreak,
    onCreated,
    onMonthOpen,
  }: Props = $props();

  let start = $state("");
  let end = $state("");
  let pause = $state<string>("");
  let reason = $state("");
  let saving = $state(false);
  let error = $state("");

  $effect(() => {
    if (open) {
      start = initialStart;
      end = initialEnd;
      pause = initialBreak != null ? String(initialBreak) : "";
      reason = "";
      error = "";
    }
  });

  const reasonError = $derived(
    reason.length > 0 && reason.trim().length < 10
      ? "Bitte beschreibe kurz, was korrigiert werden soll (mindestens 10 Zeichen)."
      : undefined,
  );
  const canSend = $derived(!saving && reason.trim().length >= 10 && reason.trim().length <= 1000);

  async function send() {
    if (!canSend) return;
    saving = true;
    error = "";
    try {
      const created = await createMonthCorrection({
        targetDate: day,
        ...(start ? { startTime: start } : {}),
        ...(end ? { endTime: end } : {}),
        ...(pause !== "" ? { breakMinutes: Number(pause) } : {}),
        reason: reason.trim(),
      });
      toasts.success(`Korrekturanfrage für ${dayLabel} gesendet · wartet auf Entscheidung`);
      open = false;
      onCreated(created);
    } catch (e) {
      const code = refusalCode(e);
      if (code === "MONTH_NOT_CLOSED") {
        open = false;
        toasts.info("Dieser Monat ist noch offen. Du kannst den Tag direkt bearbeiten.");
        onMonthOpen?.();
      } else if (code === "MONTH_CORRECTION_PENDING_EXISTS") {
        error = "Für diesen Tag wartet schon eine Korrekturanfrage auf eine Entscheidung.";
      } else {
        error =
          e instanceof Error
            ? e.message
            : "Die Anfrage ließ sich nicht senden. Bitte versuche es noch einmal.";
      }
    } finally {
      saving = false;
    }
  }
</script>

<Dialog bind:open title="Korrektur anfragen" ariaLabel="Korrektur anfragen">
  <form
    id="month-correction-form"
    class="mc-form"
    data-testid="month-correction-form"
    onsubmit={(e) => {
      e.preventDefault();
      void send();
    }}
  >
    <Note tone="info"
      >{dayLabel} liegt in einem abgeschlossenen Monat. Deine Anfrage geht an deine Leitung; eine Genehmigung
      wird als neuer Eintrag im laufenden Monat gebucht.</Note
    >
    {#if error}
      <div role="alert"><Note tone="bad">{error}</Note></div>
    {/if}
    <div class="mc-row">
      <FormField label="Beginn">
        {#snippet field({ id, describedBy })}
          <input
            {id}
            type="time"
            class="form-input"
            bind:value={start}
            aria-describedby={describedBy}
          />
        {/snippet}
      </FormField>
      <FormField label="Ende">
        {#snippet field({ id, describedBy })}
          <input
            {id}
            type="time"
            class="form-input"
            bind:value={end}
            aria-describedby={describedBy}
          />
        {/snippet}
      </FormField>
      <FormField label="Pause (Minuten)">
        {#snippet field({ id, describedBy })}
          <input
            {id}
            type="number"
            min="0"
            max="600"
            class="form-input"
            bind:value={pause}
            aria-describedby={describedBy}
          />
        {/snippet}
      </FormField>
    </div>
    <FormField
      label="Begründung"
      required
      help="Was soll korrigiert werden und warum? Zum Beispiel: Kasse hat beim Ausstempeln gehakt."
      error={reasonError}
    >
      {#snippet field({ id, describedBy, invalid })}
        <textarea
          {id}
          class="form-input"
          rows="3"
          maxlength="1000"
          bind:value={reason}
          aria-describedby={describedBy}
          aria-invalid={invalid || undefined}
        ></textarea>
      {/snippet}
    </FormField>
  </form>
  {#snippet footer()}
    <button type="button" class="btn btn-secondary" onclick={() => (open = false)}>Abbrechen</button
    >
    <button
      type="submit"
      form="month-correction-form"
      class="btn btn-primary"
      data-testid="month-correction-send"
      disabled={!canSend}
    >
      {#if saving}<Spinner size={14} label="Wird gesendet" />{/if}
      Anfrage senden
    </button>
  {/snippet}
</Dialog>

<style>
  .mc-form {
    display: flex;
    flex-direction: column;
    gap: var(--s-4);
  }
  .mc-row {
    display: grid;
    grid-template-columns: repeat(auto-fit, minmax(120px, 1fr));
    gap: var(--s-3);
  }
</style>

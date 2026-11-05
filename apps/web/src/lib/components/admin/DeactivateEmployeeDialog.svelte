<!--
  DeactivateEmployeeDialog - deactivation with a last working day (Issue #615, D-13).
  The server decides every date and figure: the dialog loads the read-only preview on open and on
  every date change, shows the saldo, the Resturlaub of the exit year and the absences the exit
  rule ends (or one calm line per figure the caller may not see), and sends the chosen day with
  the confirm. A refused day shows the server's message and blocks the confirm; a rejection of
  the deactivation itself stays inside the dialog. The browser computes no date: the default and
  the upper bound come from the preview.
-->
<script lang="ts">
  import { untrack } from "svelte";
  import Modal from "$components/ui/Modal.svelte";
  import { ApiError } from "$api/client";
  import {
    deactivateEmployee,
    loadDeactivatePreview,
    type DeactivatePreview,
  } from "$lib/api/deactivate-preview";
  import {
    absenceActionText,
    absencePeriodText,
    absenceTypeLabel,
    initialExitDay,
    SALDO_FINAL_NOTE,
    SALDO_LABEL,
    saldoLine,
    skipReasonText,
    vacationLines,
  } from "$lib/admin/deactivate-format";

  interface Props {
    open: boolean;
    employee: { id: string; firstName: string; lastName: string };
    /** Called after the deactivation succeeded; the page reloads its list. */
    onDeactivated: () => void | Promise<void>;
  }

  let { open = $bindable(), employee, onDeactivated }: Props = $props();

  // The preview shown now; null while a load runs or after a failed one.
  let view = $state<DeactivatePreview | null>(null);
  // The server's tenant-local today, the upper bound of the field (null until the first answer).
  let today = $state<string | null>(null);
  let day = $state("");
  let loading = $state(false);
  let saving = $state(false);
  let errorText = $state<string | null>(null);
  // Guards against an older response overwriting a newer one when the date changes quickly.
  let requestId = 0;

  function messageOf(err: unknown): string {
    return err instanceof ApiError
      ? err.message
      : "Die Anfrage ist fehlgeschlagen. Bitte erneut versuchen.";
  }

  // `publish = false` returns the answer without showing it (the opening flow publishes it together
  // with the day it settles on, so the field and the figures never disagree for a frame).
  async function load(exitDate?: string, publish = true): Promise<DeactivatePreview | null> {
    const mine = ++requestId;
    loading = true;
    errorText = null;
    view = null;
    try {
      const result = await loadDeactivatePreview(employee.id, exitDate);
      if (mine !== requestId) return null;
      if (publish) {
        view = result;
        today = result.today;
      }
      return result;
    } catch (err) {
      if (mine !== requestId) return null;
      errorText = messageOf(err);
      return null;
    } finally {
      if (mine === requestId) loading = false;
    }
  }

  async function start() {
    const first = await load(undefined, false);
    if (!first) return;
    const startDay = initialExitDay(first);
    day = startDay;
    if (startDay === first.exitDate) {
      view = first;
      today = first.today;
    } else {
      await load(startDay);
    }
  }

  // Start from a clean state each time the dialog opens.
  $effect(() => {
    if (!open) return;
    untrack(() => {
      view = null;
      today = null;
      day = "";
      saving = false;
      errorText = null;
      void start();
    });
  });

  let canConfirm = $derived(
    view !== null && view.refusal === null && view.exitDate === day && !loading && !saving,
  );

  async function changeDay(value: string) {
    day = value;
    if (value === "") {
      // A cleared field has no preview; drop any in-flight answer for the old day.
      requestId++;
      view = null;
      loading = false;
      return;
    }
    await load(value);
  }

  async function confirm() {
    if (!canConfirm) return;
    saving = true;
    errorText = null;
    try {
      await deactivateEmployee(employee.id, day);
    } catch (err) {
      errorText = messageOf(err);
      saving = false;
      return;
    }
    saving = false;
    open = false;
    await onDeactivated();
  }
</script>

<Modal bind:open eyebrow="Mitarbeiter deaktivieren" title="Letzter Arbeitstag festlegen">
  <div class="dx-body">
    {#if errorText}
      <div class="callout error" role="alert">{errorText}</div>
    {/if}

    <div class="callout brand" role="note">
      <p>
        {employee.firstName}
        {employee.lastName} kann sich danach nicht mehr anmelden. Die Zeitdaten bleiben erhalten.
      </p>
      <p>
        Abwesenheiten nach dem letzten Arbeitstag werden storniert oder gekürzt. Ein Reaktivieren
        bringt sie nicht zurück.
      </p>
    </div>

    {#if today !== null}
      <div class="form-group">
        <label class="form-label" for="deactivate-exit-day">Letzter Arbeitstag</label>
        <input
          id="deactivate-exit-day"
          class="form-input"
          type="date"
          value={day}
          max={today}
          disabled={saving}
          onchange={(e) => changeDay(e.currentTarget.value)}
        />
      </div>
    {/if}

    {#if loading}
      <p class="form-hint" role="status">Vorschau wird geladen …</p>
    {/if}

    {#if view !== null}
      {#if view.refusal}
        <div class="callout error" role="alert">{view.refusal.error}</div>
      {/if}

      <dl class="dx-figures">
        <div class="dx-figure">
          <dt>{SALDO_LABEL}</dt>
          <dd>
            <p>{saldoLine(view)}</p>
            {#if view.saldo}
              <p class="dx-note">{SALDO_FINAL_NOTE}</p>
            {/if}
          </dd>
        </div>
        {#if vacationLines(view).length > 0}
          <div class="dx-figure">
            <dt>Resturlaub</dt>
            <dd>
              {#each vacationLines(view) as line (line)}
                <p>{line}</p>
              {/each}
            </dd>
          </div>
        {/if}
      </dl>

      {#if view.absences !== null}
        <section class="dx-absences" aria-labelledby="dx-absences-title">
          <h4 id="dx-absences-title">Abwesenheiten, die enden</h4>
          {#if view.absences.length === 0}
            <p class="form-hint">Keine Abwesenheiten nach dem letzten Arbeitstag.</p>
          {:else}
            <ul class="dx-list">
              {#each view.absences as row (`${row.entity}-${row.id}`)}
                <li class="dx-row">
                  <span class="dx-type">{absenceTypeLabel(row.typeCode)}</span>
                  <span class="dx-period">{absencePeriodText(row)}</span>
                  <span class="dx-action">{absenceActionText(row)}</span>
                  {#if row.action === "SKIP"}
                    <span class="dx-reason">{skipReasonText(row.reason)}</span>
                  {/if}
                </li>
              {/each}
            </ul>
          {/if}
        </section>
      {/if}
    {/if}
  </div>

  {#snippet footer()}
    <button type="button" class="btn btn-ghost" disabled={saving} onclick={() => (open = false)}>
      Abbrechen
    </button>
    <button type="button" class="btn btn-danger" disabled={!canConfirm} onclick={confirm}>
      Deaktivieren
    </button>
  {/snippet}
</Modal>

<style>
  .dx-body {
    display: flex;
    flex-direction: column;
    gap: 16px;
  }
  .dx-body :global(.callout p) {
    margin: 0;
  }
  .dx-body :global(.callout p + p) {
    margin-top: 6px;
  }
  .dx-figures {
    margin: 0;
    display: flex;
    flex-direction: column;
    gap: 10px;
  }
  .dx-figure {
    display: grid;
    grid-template-columns: 110px 1fr;
    gap: 4px 12px;
    align-items: baseline;
  }
  .dx-figure dt {
    font-size: 13px;
    color: var(--text-muted);
  }
  .dx-figure dd {
    margin: 0;
    font-size: 14px;
    font-weight: 600;
    color: var(--text);
  }
  .dx-figure dd p {
    margin: 0;
  }
  .dx-figure dd .dx-note {
    font-size: 12px;
    font-weight: 400;
    color: var(--text-muted);
  }
  .dx-absences {
    border-top: 1px solid var(--border);
    padding-top: 12px;
    display: flex;
    flex-direction: column;
    gap: 8px;
  }
  .dx-absences h4 {
    margin: 0;
    font-size: 13px;
    font-weight: 600;
    color: var(--text-muted);
  }
  .dx-absences .form-hint {
    margin: 0;
  }
  .dx-list {
    list-style: none;
    margin: 0;
    padding: 0;
    display: flex;
    flex-direction: column;
    gap: 8px;
  }
  .dx-row {
    display: flex;
    flex-wrap: wrap;
    align-items: baseline;
    gap: 2px 10px;
    padding: 10px 12px;
    border: 1px solid var(--border);
    border-radius: var(--r-md);
    background: var(--bg-card);
  }
  .dx-type {
    font-size: 14px;
    font-weight: 600;
    color: var(--text);
  }
  .dx-period {
    font-size: 13px;
    color: var(--text-muted);
  }
  .dx-action {
    font-size: 13px;
    color: var(--text);
  }
  .dx-reason {
    flex-basis: 100%;
    font-size: 12px;
    color: var(--text-muted);
  }
</style>

<script lang="ts">
  /**
   * LeavePlanTakeoverDialog — Issue #835 (D-835-26/27, AC-7).
   *
   * The takeover flow of a leave plan in three steps, never two dialogs at once (a stacked Modal
   * would trap focus in the wrong layer): confirm (counts and the four-eyes sentence) -> result
   * (what happened per wish) -> reason (one `ReasonDialog` for every wish a leave limit refused).
   * The step is one state; each dialog's open state is derived from it, so a transition closes one
   * and opens the next in the same update.
   *
   * The takeover is ONE call (`takeOver`, 835-11: no batching). The component decides nothing about
   * leave: which wish is limit-refused is read from the refusal CODE, the German text is display
   * only. Mounted inside the page but OUTSIDE any animated block (#570).
   */
  import { untrack } from "svelte";
  import ConfirmDialog from "$components/ui/ConfirmDialog.svelte";
  import ReasonDialog from "$components/ui/ReasonDialog.svelte";
  import Modal from "$components/ui/Modal.svelte";
  import { takeOver } from "$lib/leave-plan/api";
  import { planErrorMessage } from "$lib/leave-plan/errors";
  import { mergeTakeoverResults } from "$lib/leave-plan/takeover-result";
  import { PENDING_REASON_LABELS, PLAN_STATUS_LABELS } from "$lib/leave-plan/labels";
  import {
    LEAVE_LIMIT_EXCEPTION_REQUIRED,
    validateExceptionReason,
  } from "$lib/leave-limits/exception";
  import type { PlannerPerson, TakeoverResult } from "$lib/leave-plan/types";

  interface Props {
    open: boolean;
    planId: string;
    openWishCount: number;
    /** The persons of the plan as the page holds them (names and wish dates for the result list). */
    personsById: Record<string, PlannerPerson>;
    /** Called after the dialog closed, but only when a takeover ran, so the page reloads the plan. */
    onDone: () => void;
  }

  let { open = $bindable(), planId, openWishCount, personsById, onDone }: Props = $props();

  type Step = "closed" | "confirm" | "result" | "reason";
  let step = $state<Step>("closed");
  let result = $state<TakeoverResult | null>(null);
  let errorText = $state("");

  $effect(() => {
    if (open && step === "closed") {
      untrack(() => {
        result = null;
        errorText = "";
        step = "confirm";
      });
    }
  });

  function finish() {
    const ran = result !== null;
    step = "closed";
    open = false;
    if (ran) onDone();
  }

  function fmtDate(iso: string): string {
    const [y, m, d] = iso.split("-");
    return `${d}.${m}.${y}`;
  }

  function nameOf(employeeId: string): string {
    const person = personsById[employeeId];
    return person ? `${person.firstName} ${person.lastName}` : "Unbekannte Person";
  }

  function datesOf(employeeId: string, wishId: string): string {
    const wish = personsById[employeeId]?.wishes.find((w) => w.id === wishId);
    if (!wish) return "";
    return wish.startDate === wish.endDate
      ? fmtDate(wish.startDate)
      : `${fmtDate(wish.startDate)} – ${fmtDate(wish.endDate)}`;
  }

  async function runTakeover() {
    errorText = "";
    try {
      result = await takeOver(planId);
    } catch (err) {
      // ConfirmDialog swallows the rethrow and stays open; the message is shown in its body.
      errorText = planErrorMessage(err);
      throw err;
    }
    step = "result";
  }

  let limitRefused = $derived(
    result?.refused.filter((entry) => entry.code === LEAVE_LIMIT_EXCEPTION_REQUIRED) ?? [],
  );

  async function submitReason(reason: string) {
    const problem = validateExceptionReason(reason);
    // ReasonDialog shows a thrown message inline and stays open; nothing is sent.
    if (problem) throw new Error(problem);
    const earlier = result;
    const later = await takeOver(
      planId,
      limitRefused.map((entry) => ({ wishId: entry.wishId, reason })),
    );
    // IN-01: the reason run skips every wish the first run linked; the merge keeps them listed.
    result = earlier ? mergeTakeoverResults(earlier, later) : later;
    step = "result";
  }
</script>

<ConfirmDialog
  bind:open={() => step === "confirm", (value) => value || step !== "confirm" || finish()}
  title="Urlaubsplanung übernehmen"
  confirmLabel="Übernehmen"
  onConfirm={runTakeover}
>
  {#snippet body()}
    <div class="takeover-body" data-testid="takeover-confirm">
      <p class="takeover-count" data-testid="takeover-count">
        {openWishCount === 1
          ? "1 offener Wunsch wird in einen Urlaubsantrag übernommen."
          : `${openWishCount} offene Wünsche werden in Urlaubsanträge übernommen.`}
      </p>
      <p class="takeover-note">
        Deine eigenen Wünsche werden als Antrag zur Genehmigung durch eine andere Person angelegt.
      </p>
      {#if errorText}
        <p class="takeover-error" role="alert" data-testid="takeover-error">{errorText}</p>
      {/if}
    </div>
  {/snippet}
</ConfirmDialog>

<Modal
  bind:open={() => step === "result", (value) => value || step !== "result" || finish()}
  title="Ergebnis der Übernahme"
>
  {#if result}
    <div class="takeover-body" data-testid="takeover-result">
      <p class="takeover-status" data-testid="takeover-plan-status">
        Die Planung ist jetzt: <strong
          >{result.planStatus === "TAKEN_OVER"
            ? PLAN_STATUS_LABELS.TAKEN_OVER
            : PLAN_STATUS_LABELS.OPEN}</strong
        >.
      </p>

      {#if result.created.length > 0}
        <section class="takeover-group" data-testid="takeover-created">
          <h4>Übernommen ({result.created.length})</h4>
          <ul>
            {#each result.created as entry (entry.wishId)}
              <li>{nameOf(entry.employeeId)} · {datesOf(entry.employeeId, entry.wishId)}</li>
            {/each}
          </ul>
        </section>
      {/if}

      {#if result.pending.length > 0}
        <section class="takeover-group" data-testid="takeover-pending">
          <h4>Wartet auf Genehmigung ({result.pending.length})</h4>
          <ul>
            {#each result.pending as entry (entry.wishId)}
              <li>
                {nameOf(entry.employeeId)} · {datesOf(entry.employeeId, entry.wishId)}
                <span class="takeover-reason">{PENDING_REASON_LABELS[entry.reason]}</span>
              </li>
            {/each}
          </ul>
        </section>
      {/if}

      {#if result.refused.length > 0}
        <section class="takeover-group" data-testid="takeover-refused">
          <h4>Abgelehnt ({result.refused.length})</h4>
          <ul>
            {#each result.refused as entry (entry.wishId)}
              <li>
                {nameOf(entry.employeeId)} · {datesOf(entry.employeeId, entry.wishId)}
                <span class="takeover-reason">{entry.error}</span>
              </li>
            {/each}
          </ul>
        </section>
      {/if}

      {#if result.created.length + result.pending.length + result.refused.length === 0}
        <p class="takeover-note">Es gab keine offenen Wünsche zu übernehmen.</p>
      {/if}
    </div>
  {/if}
  {#snippet footer()}
    {#if limitRefused.length > 0}
      <button
        class="btn btn-ghost"
        type="button"
        data-testid="takeover-explain"
        onclick={() => (step = "reason")}
      >
        Ausnahme begründen
      </button>
    {/if}
    <button class="btn btn-primary" type="button" data-testid="takeover-done" onclick={finish}>
      Fertig
    </button>
  {/snippet}
</Modal>

<ReasonDialog
  bind:open={() => step === "reason", (value) => value || step !== "reason" || (step = "result")}
  title="Ausnahme begründen"
  description={limitRefused.length === 1
    ? "Eine Urlaubsgrenze würde überschritten. Die Begründung wird mit der Genehmigung gespeichert."
    : `${limitRefused.length} Wünsche würden eine Urlaubsgrenze überschreiten. Die Begründung gilt für alle und wird je Genehmigung gespeichert.`}
  label="Begründung der Ausnahme"
  confirmLabel="Trotzdem übernehmen"
  onConfirm={submitReason}
/>

<style>
  .takeover-body {
    display: flex;
    flex-direction: column;
    gap: var(--s-3);
  }
  .takeover-body p,
  .takeover-body h4,
  .takeover-body ul {
    margin: 0;
  }
  .takeover-note {
    color: var(--text-2);
    font-size: 0.875rem;
  }
  .takeover-error {
    color: var(--bad);
    font-size: 0.875rem;
  }
  .takeover-group h4 {
    font-size: 0.875rem;
    margin-bottom: var(--s-1);
  }
  .takeover-group ul {
    padding-left: var(--s-4);
    display: flex;
    flex-direction: column;
    gap: var(--s-1);
    font-size: 0.875rem;
  }
  .takeover-reason {
    display: block;
    color: var(--text-2);
    overflow-wrap: anywhere;
  }
</style>

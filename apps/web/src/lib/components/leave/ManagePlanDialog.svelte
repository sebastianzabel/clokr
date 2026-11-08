<script lang="ts">
  /**
   * ManagePlanDialog — Issue #840 (D-840-15, AC-11). „Planung verwalten“.
   *
   * The one home of the planner's admin controls: the plan status, „Plan eröffnen“, the wish
   * deadline and „Übernehmen“. The work surface carries none of them; the host opens this dialog
   * only when the server said `viewer.canManage`.
   *
   * The deadline is a form group with a section button (docs/ADMIN_STRUCTURE.md §3.2.1): typing a
   * date and leaving the field writes nothing, every write sits behind a button. Closing the dialog
   * discards an unsaved date, and the dialog registers nothing with the layout's unsaved-changes
   * guard, so a tab change is never blocked by it.
   *
   * The takeover keeps its own dialog (`LeavePlanTakeoverDialog`): „Übernehmen“ closes this dialog
   * first and then calls `onTakeover`, so two modals are never stacked. Server refusals are shown
   * inline through `planErrorMessage`; the dialog stays open. It decides nothing about access — the
   * API refuses every write without `leave-plan:manage` reach.
   */
  import { untrack } from "svelte";
  import Modal from "$components/ui/Modal.svelte";
  import { toasts } from "$stores/toast";
  import { openPlan, setDeadline } from "$lib/leave-plan/api";
  import { isPlanAlreadyOpen, planErrorMessage } from "$lib/leave-plan/errors";
  import { planStatusLabel } from "$lib/leave-plan/labels";

  interface Props {
    open: boolean;
    salonId: string;
    year: number;
    plan: {
      id: string;
      status: "OPEN" | "TAKEN_OVER";
      deadline: string | null;
      partiallyTakenOver?: boolean;
    } | null;
    /** Counted by the server with the takeover's own close rule; `null` = not told. */
    openWishCount: number | null;
    onChanged: () => Promise<void> | void;
    onTakeover: () => void;
  }

  let {
    open = $bindable(),
    salonId,
    year,
    plan,
    openWishCount,
    onChanged,
    onTakeover,
  }: Props = $props();

  const isOpenPlan = $derived(plan?.status === "OPEN");

  let initialDeadline = $state("");
  let deadlineInput = $state("");
  let busy = $state(false);
  let actionError = $state("");

  // The date field follows the stored deadline whenever a (re)loaded plan carries another one and
  // is reset when the dialog closes or opens, so an unsaved date never survives; typing overrides
  // it in between. The error line is cleared when the dialog opens, not when the plan reloads
  // (a refusal must stay readable after the resync it triggers).
  const storedDeadline = $derived(plan?.deadline ?? "");
  let wasOpen = false;
  $effect(() => {
    const isOpen = open;
    const stored = storedDeadline;
    untrack(() => {
      deadlineInput = stored;
      if (isOpen && !wasOpen) actionError = "";
      wasOpen = isOpen;
    });
  });

  function fmtDate(iso: string): string {
    const [y, m, d] = iso.split("-");
    return `${d}.${m}.${y}`;
  }

  async function doOpenPlan() {
    if (busy) return;
    busy = true;
    actionError = "";
    try {
      await openPlan({
        salonId,
        year,
        deadline: initialDeadline === "" ? null : initialDeadline,
      });
      initialDeadline = "";
      toasts.success("Die Urlaubsplanung ist eröffnet.");
      await onChanged();
    } catch (err) {
      actionError = planErrorMessage(err);
      // Somebody else opened it first: show the server's sentence and resync with the stored plan.
      if (isPlanAlreadyOpen(err)) await onChanged();
    } finally {
      busy = false;
    }
  }

  async function saveDeadline(value: string | null) {
    if (!plan || busy) return;
    busy = true;
    actionError = "";
    try {
      await setDeadline(plan.id, value);
      toasts.success(value ? "Die Frist ist gespeichert." : "Die Frist ist entfernt.");
      await onChanged();
    } catch (err) {
      actionError = planErrorMessage(err);
    } finally {
      busy = false;
    }
  }

  function startTakeover() {
    open = false;
    onTakeover();
  }
</script>

<Modal bind:open eyebrow="Urlaubsplanung" title="Planung verwalten">
  <div class="manage" data-testid="manage-plan-dialog">
    {#if actionError}
      <p class="form-error" role="alert" data-testid="manage-plan-error">{actionError}</p>
    {/if}

    <section class="manage-section" aria-labelledby="manage-status">
      <h4 id="manage-status" class="manage-title">Status</h4>
      {#if plan}
        <p data-testid="manage-plan-status">
          <span class="badge {plan.status === 'OPEN' ? 'badge-blue' : 'badge-green'}"
            >{planStatusLabel({
              status: plan.status,
              partiallyTakenOver: plan.partiallyTakenOver ?? false,
            })}</span
          >
          {#if isOpenPlan && openWishCount !== null}
            <span class="form-hint" data-testid="manage-plan-open-count">
              {openWishCount === 1 ? "1 offener Wunsch" : `${openWishCount} offene Wünsche`}
            </span>
          {/if}
        </p>
      {:else}
        <p class="form-hint">Für {year} ist noch keine Planung eröffnet.</p>
      {/if}
    </section>

    {#if plan === null}
      <section class="manage-section" aria-labelledby="manage-open">
        <h4 id="manage-open" class="manage-title">Plan eröffnen</h4>
        <p class="form-hint">
          Alle Personen des Salons können danach ihre Urlaubswünsche eintragen. Eine Frist ist
          optional.
        </p>
        <div class="manage-row">
          <label class="form-label" for="plan-open-deadline">Wünsche bis (optional)</label>
          <input
            id="plan-open-deadline"
            type="date"
            class="form-input manage-date"
            bind:value={initialDeadline}
          />
        </div>
        <div>
          <button
            type="button"
            class="btn btn-primary"
            data-testid="leave-plan-open"
            disabled={busy}
            onclick={doOpenPlan}
          >
            Plan eröffnen
          </button>
        </div>
      </section>
    {:else if isOpenPlan}
      <section class="manage-section" aria-labelledby="manage-deadline">
        <h4 id="manage-deadline" class="manage-title">Frist</h4>
        <div class="manage-row">
          <label class="form-label" for="plan-deadline">Frist für Wünsche</label>
          <input
            id="plan-deadline"
            type="date"
            class="form-input manage-date"
            bind:value={deadlineInput}
          />
        </div>
        {#if plan.deadline}
          <p class="form-hint" data-testid="manage-plan-stored-deadline">
            Gespeichert: {fmtDate(plan.deadline)}
          </p>
        {/if}
        <div class="manage-actions">
          <button
            type="button"
            class="btn btn-secondary btn-sm"
            data-testid="leave-plan-deadline"
            disabled={busy || deadlineInput === "" || deadlineInput === plan.deadline}
            onclick={() => saveDeadline(deadlineInput)}
          >
            Frist speichern
          </button>
          {#if plan.deadline}
            <button
              type="button"
              class="btn btn-ghost btn-sm"
              data-testid="leave-plan-deadline-remove"
              disabled={busy}
              onclick={() => saveDeadline(null)}
            >
              Frist entfernen
            </button>
          {/if}
        </div>
      </section>

      <section class="manage-section" aria-labelledby="manage-takeover">
        <h4 id="manage-takeover" class="manage-title">Übernehmen</h4>
        <p class="form-hint">
          Aus den offenen Wünschen werden Urlaubsanträge. Du bestätigst vorher, was passiert.
        </p>
        <div>
          <button
            type="button"
            class="btn btn-secondary"
            data-testid="leave-plan-takeover"
            disabled={busy || !openWishCount}
            onclick={startTakeover}
          >
            Planung übernehmen
          </button>
        </div>
      </section>
    {/if}
  </div>

  {#snippet footer()}
    <button type="button" class="btn btn-ghost" onclick={() => (open = false)}>Schließen</button>
  {/snippet}
</Modal>

<style>
  .manage {
    display: flex;
    flex-direction: column;
    gap: var(--s-4);
  }
  .manage-section {
    display: flex;
    flex-direction: column;
    gap: var(--s-2);
  }
  .manage-section p {
    margin: 0;
  }
  .manage-title {
    margin: 0;
    font-size: 0.875rem;
    font-weight: 600;
  }
  .manage-row {
    display: flex;
    flex-direction: column;
    gap: var(--s-1);
  }
  .manage-date {
    max-width: 16rem;
  }
  .manage-actions {
    display: flex;
    flex-wrap: wrap;
    gap: var(--s-2);
  }
</style>

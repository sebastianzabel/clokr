<script lang="ts">
  /**
   * LeavePlanWishDialog — Issue #835 (D-835-21).
   *
   * The wish form: the keyboard path next to dragging in the timeline, and the only path on a
   * phone. Create (empty or preset from `defaults`) or edit (`wish`). A manager names the person
   * through `persons`; without `persons` the wish is the caller's own. The halved day is offered
   * only for a single day. The component writes nothing itself: `onSave` / `onRemove` belong to the
   * parent, and when `onSave` throws (an ApiError) the dialog stays open and shows the server's
   * German message — the server is the authority, the checks here only save a round trip.
   *
   * It imports neither the auth store nor the API client, so it stays mountable in vitest.
   */
  import { untrack } from "svelte";
  import Modal from "$components/ui/Modal.svelte";
  import { planErrorMessage } from "$lib/leave-plan/errors";
  import {
    WISH_FOREIGN_PLAN_HINT,
    WISH_READ_ONLY_HINT,
    WISH_TAKEN_OVER_HINT,
  } from "$lib/leave-plan/labels";
  import type { PlannerWish, WishInput } from "$lib/leave-plan/types";

  interface Props {
    open: boolean;
    year: number;
    /** Choosable persons for a manager; `null` = the caller's own wish only. */
    persons: Array<{ employeeId: string; label: string }> | null;
    /** The wish to edit, or `null` to create one. */
    wish: PlannerWish | null;
    defaults?: { employeeId?: string; startDate?: string };
    onSave: (payload: WishInput) => Promise<void>;
    onRemove?: (wish: PlannerWish) => Promise<void>;
  }

  let { open = $bindable(), year, persons, wish, defaults, onSave, onRemove }: Props = $props();

  let employeeId = $state("");
  let startDate = $state("");
  let endDate = $state("");
  let halfDay = $state(false);
  let saving = $state(false);
  let error = $state("");

  let wasOpen = false;
  $effect(() => {
    if (open && !wasOpen) {
      untrack(() => {
        employeeId = wish ? "" : (defaults?.employeeId ?? "");
        startDate = wish?.startDate ?? defaults?.startDate ?? "";
        endDate = wish?.endDate ?? defaults?.startDate ?? "";
        halfDay = wish?.halfDay ?? false;
        error = "";
        saving = false;
      });
    }
    wasOpen = open;
  });

  let singleDay = $derived(startDate !== "" && startDate === endDate);
  $effect(() => {
    if (!singleDay) halfDay = false;
  });

  let minDay = $derived(`${year}-01-01`);
  let maxDay = $derived(`${year}-12-31`);
  let readOnly = $derived(
    wish !== null && (!wish.editable || wish.foreignPlan || wish.leaveRequestId !== null),
  );
  let readOnlyHint = $derived(
    wish === null
      ? ""
      : wish.leaveRequestId !== null
        ? WISH_TAKEN_OVER_HINT
        : wish.foreignPlan
          ? WISH_FOREIGN_PLAN_HINT
          : WISH_READ_ONLY_HINT,
  );

  function onStartInput() {
    if (endDate === "" || endDate < startDate) endDate = startDate;
  }

  function validate(): string | null {
    if (persons !== null && wish === null && employeeId === "") return "Wähle eine Person aus.";
    if (startDate === "" || endDate === "") return "Gib Von und Bis an.";
    if (endDate < startDate) return "Das Enddatum darf nicht vor dem Startdatum liegen.";
    if (startDate < minDay || endDate > maxDay) {
      return "Der Wunsch muss vollständig im Planungsjahr liegen.";
    }
    return null;
  }

  async function save() {
    const invalid = validate();
    if (invalid) {
      error = invalid;
      return;
    }
    saving = true;
    error = "";
    try {
      const payload: WishInput = { startDate, endDate, halfDay: singleDay && halfDay };
      if (persons !== null && wish === null) payload.employeeId = employeeId;
      await onSave(payload);
      open = false;
    } catch (e: unknown) {
      error = planErrorMessage(e);
    } finally {
      saving = false;
    }
  }

  async function remove() {
    if (!wish || !onRemove) return;
    saving = true;
    error = "";
    try {
      await onRemove(wish);
      open = false;
    } catch (e: unknown) {
      error = planErrorMessage(e);
    } finally {
      saving = false;
    }
  }
</script>

<Modal
  bind:open
  eyebrow="Urlaubsplanung"
  title={wish ? "Urlaubswunsch" : "Urlaubswunsch hinzufügen"}
>
  <form
    class="wish-form"
    data-testid="leave-plan-wish-form"
    onsubmit={(event) => {
      event.preventDefault();
      if (!readOnly) void save();
    }}
  >
    {#if readOnly}
      <p class="form-hint" data-testid="wish-read-only-hint">{readOnlyHint}</p>
    {/if}

    {#if persons !== null}
      <div class="form-group">
        <label class="form-label" for="wish-person">Person</label>
        <select
          id="wish-person"
          class="form-input"
          data-testid="wish-person"
          bind:value={employeeId}
          disabled={wish !== null || readOnly}
        >
          {#if wish === null}<option value="">Bitte wählen</option>{/if}
          {#each persons as person (person.employeeId)}
            <option value={person.employeeId}>{person.label}</option>
          {/each}
        </select>
      </div>
    {/if}

    <div class="wish-dates">
      <div class="form-group">
        <label class="form-label" for="wish-start">Von</label>
        <input
          id="wish-start"
          class="form-input"
          data-testid="wish-start"
          type="date"
          min={minDay}
          max={maxDay}
          bind:value={startDate}
          oninput={onStartInput}
          disabled={readOnly}
        />
      </div>
      <div class="form-group">
        <label class="form-label" for="wish-end">Bis</label>
        <input
          id="wish-end"
          class="form-input"
          data-testid="wish-end"
          type="date"
          min={startDate || minDay}
          max={maxDay}
          bind:value={endDate}
          disabled={readOnly}
        />
      </div>
    </div>

    {#if singleDay}
      <label class="wish-check">
        <input
          type="checkbox"
          data-testid="wish-half-day"
          bind:checked={halfDay}
          disabled={readOnly}
        />
        <span>Halber Tag</span>
      </label>
    {/if}

    {#if error}
      <p class="form-error" role="alert" data-testid="wish-error">{error}</p>
    {/if}
  </form>

  {#snippet footer()}
    {#if wish && onRemove && !readOnly}
      <button
        type="button"
        class="btn btn-ghost wish-remove"
        data-testid="wish-remove"
        disabled={saving}
        onclick={remove}
      >
        Wunsch entfernen
      </button>
    {/if}
    <button type="button" class="btn btn-ghost" onclick={() => (open = false)}>
      {readOnly ? "Schließen" : "Abbrechen"}
    </button>
    {#if !readOnly}
      <button
        type="button"
        class="btn btn-primary"
        data-testid="wish-save"
        disabled={saving}
        onclick={save}
      >
        Speichern
      </button>
    {/if}
  {/snippet}
</Modal>

<style>
  .wish-form {
    display: flex;
    flex-direction: column;
    gap: 1rem;
  }

  .wish-dates {
    display: grid;
    grid-template-columns: 1fr 1fr;
    gap: 1rem;
  }

  .wish-check {
    display: flex;
    align-items: center;
    gap: 0.5rem;
    font-size: 0.9375rem;
    color: var(--text);
  }

  .wish-remove {
    margin-right: auto;
    color: var(--bad);
  }

  @media (max-width: 480px) {
    .wish-dates {
      grid-template-columns: 1fr;
    }
  }
</style>

<script lang="ts">
  /**
   * LeavePlanWishList — Issue #835 (D-835-21).
   *
   * The phone view of the planner: a readable list of wishes instead of a timeline. The own person
   * comes first, then the colleagues by name. A wish offers edit and remove only when the API said
   * it is `editable` (and it is not a foreign plan's or a taken-over wish). The list writes nothing:
   * every action is a callback of the parent.
   */
  import {
    ADD_WISH_LABEL,
    NO_WISHES_LABEL,
    ROW_STATE_LABELS,
    WISH_CONFLICT_HINT,
    WISH_FOREIGN_PLAN_HINT,
    WISH_TAKEN_OVER_HINT,
  } from "$lib/leave-plan/labels";
  import type { PlannerPerson, PlannerWish } from "$lib/leave-plan/types";

  interface Props {
    persons: PlannerPerson[];
    ownEmployeeId: string | null;
    onEdit: (wish: PlannerWish) => void;
    onRemove: (wish: PlannerWish) => void;
    /** Starts a new wish; the argument is the own employee id (a manager picks the person in the form). */
    onAdd: (employeeId: string | null) => void;
    /** Hides the add button (closed plan, nobody to wish for). Default: shown. */
    canAdd?: boolean;
  }

  let { persons, ownEmployeeId, onEdit, onRemove, onAdd, canAdd = true }: Props = $props();

  function fmtDate(iso: string): string {
    const [y, m, d] = iso.split("-");
    return `${d}.${m}.${y}`;
  }

  function isEditable(wish: PlannerWish): boolean {
    return wish.editable && !wish.foreignPlan && wish.leaveRequestId === null;
  }

  function nameOf(person: PlannerPerson): string {
    return `${person.firstName} ${person.lastName}`;
  }

  let groups = $derived.by(() => {
    const byName = (a: PlannerPerson, b: PlannerPerson) =>
      a.lastName.localeCompare(b.lastName, "de") ||
      a.firstName.localeCompare(b.firstName, "de") ||
      a.employeeId.localeCompare(b.employeeId);
    const own = persons.filter((p) => p.employeeId === ownEmployeeId);
    const others = persons
      .filter((p) => p.employeeId !== ownEmployeeId && p.wishes.length > 0)
      .sort(byName);
    return [...own, ...others].map((person) => ({
      person,
      isOwn: person.employeeId === ownEmployeeId,
      wishes: [...person.wishes].sort(
        (a, b) => a.startDate.localeCompare(b.startDate) || a.id.localeCompare(b.id),
      ),
    }));
  });
</script>

<div class="wish-list" data-testid="leave-plan-wish-list">
  {#if canAdd}
    <button
      type="button"
      class="btn btn-primary"
      data-testid="wish-add"
      onclick={() => onAdd(ownEmployeeId)}
    >
      {ADD_WISH_LABEL}
    </button>
  {/if}

  {#each groups as group (group.person.employeeId)}
    <section class="wish-group" data-testid="wish-group-{group.person.employeeId}">
      <h3 class="wish-group-title">{group.isOwn ? "Meine Wünsche" : nameOf(group.person)}</h3>
      {#if group.wishes.length === 0}
        <p class="form-hint">{NO_WISHES_LABEL}</p>
      {:else}
        <ul class="wish-items">
          {#each group.wishes as wish (wish.id)}
            <li class="wish-item" data-testid="wish-item-{wish.id}">
              <div class="wish-main">
                <span class="wish-dates font-mono">
                  {fmtDate(wish.startDate)} – {fmtDate(wish.endDate)}
                </span>
                {#if wish.halfDay}<span class="wish-half">halber Tag</span>{/if}
                {#if wish.leaveRequestId !== null}
                  <span class="badge badge-green">{WISH_TAKEN_OVER_HINT}</span>
                {:else if wish.foreignPlan}
                  <span class="badge badge-gray">{WISH_FOREIGN_PLAN_HINT}</span>
                {:else}
                  <span class="badge badge-blue">{ROW_STATE_LABELS.WISH}</span>
                {/if}
                {#if wish.conflict}
                  <span class="badge badge-orange" data-testid="wish-conflict-{wish.id}"
                    >{WISH_CONFLICT_HINT}</span
                  >
                {/if}
              </div>
              {#if wish.refusalMessage}
                <p class="form-error">{wish.refusalMessage}</p>
              {/if}
              {#if isEditable(wish)}
                <div class="wish-actions">
                  <button
                    type="button"
                    class="btn btn-sm btn-secondary"
                    data-testid="wish-edit-{wish.id}"
                    onclick={() => onEdit(wish)}
                  >
                    Bearbeiten
                  </button>
                  <button
                    type="button"
                    class="btn btn-sm btn-ghost"
                    data-testid="wish-remove-{wish.id}"
                    onclick={() => onRemove(wish)}
                  >
                    Entfernen
                  </button>
                </div>
              {/if}
            </li>
          {/each}
        </ul>
      {/if}
    </section>
  {/each}
</div>

<style>
  .wish-list {
    display: flex;
    flex-direction: column;
    gap: 1rem;
  }

  .wish-group {
    background: var(--bg-card);
    border: 1px solid var(--border);
    border-radius: var(--r-md);
    padding: 0.75rem 1rem;
  }

  .wish-group-title {
    margin: 0 0 0.5rem;
    font-size: 1rem;
    font-weight: 600;
    color: var(--text);
  }

  .wish-items {
    list-style: none;
    margin: 0;
    padding: 0;
    display: flex;
    flex-direction: column;
    gap: 0.75rem;
  }

  .wish-item {
    display: flex;
    flex-direction: column;
    gap: 0.5rem;
    padding-top: 0.75rem;
    border-top: 1px solid var(--border);
  }

  .wish-item:first-child {
    padding-top: 0;
    border-top: none;
  }

  .wish-main {
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    gap: 0.5rem;
  }

  .wish-dates {
    font-size: 0.9375rem;
    color: var(--text);
  }

  .wish-half {
    font-size: 0.8125rem;
    color: var(--text-muted);
  }

  .wish-actions {
    display: flex;
    gap: 0.5rem;
  }
</style>

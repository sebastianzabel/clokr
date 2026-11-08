<script lang="ts">
  /**
   * LeavePlanControls — Issue #840 G-6. The planner's status, the deadline text and „Wunsch
   * hinzufügen“ for the filter area of the one `LeaveToolbar`, on the Planung tab of both areas.
   *
   * Presentation only and without state of its own: `LeavePlanningPanel` decides `canAdd` from the
   * server's planner viewer and reports the whole shape through `onControls`; the host passes it
   * on. The API refuses every wish write without reach (T-840-63).
   */
  import { ADD_WISH_LABEL } from "$lib/leave-plan/labels";

  interface Props {
    controls: {
      statusLabel: string;
      statusOpen: boolean;
      deadlineText: string | null;
      canAdd: boolean;
      add: () => void;
    };
  }

  let { controls }: Props = $props();
</script>

<div class="plan-controls" data-testid="leave-plan-head">
  <span class="badge {controls.statusOpen ? 'badge-blue' : 'badge-green'}"
    >{controls.statusLabel}</span
  >
  {#if controls.deadlineText}
    <span class="plan-deadline" data-testid="leave-plan-deadline-text">{controls.deadlineText}</span
    >
  {/if}
  {#if controls.canAdd}
    <button
      type="button"
      class="btn btn-primary btn-sm"
      data-testid="leave-plan-add-wish"
      onclick={() => controls.add()}
    >
      {ADD_WISH_LABEL}
    </button>
  {/if}
</div>

<style>
  .plan-controls {
    display: flex;
    align-items: center;
    flex-wrap: wrap;
    gap: var(--s-3);
  }
  .plan-deadline {
    color: var(--text-muted);
    font-size: 0.875rem;
  }
</style>

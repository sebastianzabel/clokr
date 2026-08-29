<script lang="ts">
  /**
   * UnconfirmedBreakPanel — Phase 112 (GitHub issue #115).
   *
   * The employee-facing explanation that never existed. Until now the only prose about
   * automatic Pflichtpausen was admin-facing (admin/system/+page.svelte) plus the
   * BREAK_UNCONFIRMED notification body; on /time-entries the employee saw only the words
   * "Pause unbestätigt" and three verbs, with no statement that the SYSTEM entered the break
   * or that § 4 ArbZG requires it.
   *
   * It also IS the mobile access path (issue #115, criterion 6): the list table has nine
   * columns inside `overflow-x: auto`, and its ✏️ action column — the only route into the
   * confirm modal — sits off-screen at 384 px. This panel is a normal block element ABOVE the
   * table, so tapping a day needs no horizontal scrolling at all.
   *
   * Scope: the days of the CURRENTLY LOADED month only. The dashboard nudge counts a 12-month
   * window; reconciling the two windows is deliberately out of scope for issue #115. The flow
   * still terminates, because the nudge always links to the OLDEST unconfirmed day — confirming
   * what is shown here drops the count and the next click walks to the next-oldest month.
   */
  interface UnconfirmedDay {
    entryId: string;
    /** "YYYY-MM-DD" — used for the testid so a day is addressable without knowing the uuid. */
    date: string;
    /** German display label, e.g. "05.08.2026". */
    label: string;
  }

  interface Props {
    days: UnconfirmedDay[];
    onOpen: (entryId: string) => void;
  }

  let { days, onOpen }: Props = $props();

  const heading = $derived(
    days.length === 1 ? "1 Tag: Pause bestätigen" : `${days.length} Tage: Pause bestätigen`,
  );
</script>

{#if days.length > 0}
  <div class="callout ub-panel" role="status" data-testid="unconfirmed-breaks-panel">
    <span class="ico" aria-hidden="true">⚠</span>
    <div class="ub-body">
      <p><b>{heading}</b></p>
      <p>
        An diesen Tagen wurde die gesetzlich vorgeschriebene Pause nach § 4 ArbZG automatisch
        eingetragen, weil keine Pause erfasst wurde. Bitte bestätige sie – oder erkläre den Tag als
        „durchgearbeitet“.
      </p>
      <div class="ub-days">
        {#each days as day (day.entryId)}
          <button
            type="button"
            class="btn btn-sm btn-secondary"
            data-testid={`unconfirmed-break-day-${day.date}`}
            onclick={() => onOpen(day.entryId)}
          >
            {day.label}
          </button>
        {/each}
      </div>
    </div>
  </div>
{/if}

<style>
  /* Colour comes from the global .callout recipe (app.css) — only layout here. */
  .ub-panel {
    margin-bottom: 1rem;
  }
  .ub-body {
    display: flex;
    flex-direction: column;
    gap: 0.5rem;
    min-width: 0;
  }
  .ub-days {
    display: flex;
    flex-wrap: wrap;
    gap: 0.5rem;
  }

  /* 384 px: the day buttons are the mobile access path to the confirm modal, so they get a
     full 44 px touch target and are allowed to wrap onto as many rows as they need. */
  @media (max-width: 640px) {
    .ub-days button {
      min-height: 44px;
      padding: 0.5rem 0.875rem;
    }
  }
</style>

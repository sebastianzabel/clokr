<script lang="ts">
  /**
   * The tapped day's absences, spelled out (GitHub issue #265).
   *
   * Below 700px the team calendar hides the bar's type label, which left the absence type
   * distinguishable by COLOUR ALONE — WCAG 1.4.1, and worst for Krank (#d97706) against
   * Kinderkrank (#ea580c). The `title` tooltip already carried the text but no finger can open
   * it, so the remedy has to be reachable by TAP and by KEYBOARD. This sheet is what the tap
   * opens.
   *
   * It lives in a component rather than inline in `(app)/team/leave/+page.svelte` because the
   * page cannot be mounted in a test — it imports `$app/stores`, for which
   * `apps/web/vitest.config.ts` registers no alias. Here the role rule and the plain-text
   * output are provable against a real DOM.
   *
   * Reachability is not this component's own doing and deliberately so: `Modal` already owns
   * Escape, the focus trap and the backdrop click, and the trigger in the page is a real
   * `<button>`, so Enter and Space come from the platform. The one thing this component must add
   * is a visible "Schließen" button — on a touch device there is no Escape key.
   */
  import Modal from "$components/ui/Modal.svelte";
  import { resolveDayDetailRows, type DayDetailEntry } from "$lib/leave/team-calendar-visibility";

  interface Props {
    /** Two-way bindable open state, forwarded to `Modal`. */
    open: boolean;
    /** German date of the tapped day, e.g. "21.09.2026". Rendered as the sheet's title. */
    dateLabel: string;
    /** The day's absence bars, in the order the calendar stacked them. */
    entries: readonly DayDetailEntry[];
    /** Viewer role from the auth store. Decides whether a type may be named at all (#257). */
    role: string | null | undefined;
  }

  let { open = $bindable(), dateLabel, entries, role }: Props = $props();

  // ONE decision per row, taken by the shared module — never a second role check here (D-10).
  let rows = $derived(resolveDayDetailRows(entries, role));
</script>

<Modal bind:open eyebrow="Abwesenheiten" title={dateLabel}>
  <div data-testid="cal-day-detail">
    {#if rows.length === 0}
      <p class="form-hint">Keine Abwesenheiten an diesem Tag.</p>
    {:else}
      <ul class="day-detail-list">
        {#each rows as row (row.id)}
          <li class="day-detail-row">
            <span class="day-detail-dot" style:background={row.background}></span>
            <span class="day-detail-name">{row.name}</span>
            <span class="day-detail-type" data-testid="cal-day-detail-type">{row.typeLabel}</span>
            {#if row.isPending}
              <span class="badge badge-yellow">ausstehend</span>
            {/if}
          </li>
        {/each}
      </ul>
    {/if}
  </div>
  {#snippet footer()}
    <button
      type="button"
      class="btn btn-ghost"
      data-testid="cal-day-detail-close"
      onclick={() => (open = false)}
    >
      Schließen
    </button>
  {/snippet}
</Modal>

<style>
  .day-detail-list {
    list-style: none;
    margin: 0;
    padding: 0;
    display: flex;
    flex-direction: column;
    gap: 0.5rem;
  }
  .day-detail-row {
    display: flex;
    align-items: center;
    gap: 0.5rem;
    flex-wrap: wrap;
    padding: 0.5rem 0.75rem;
    background: var(--bg-subtle);
    border: 1px solid var(--border);
    border-radius: var(--r-sm);
  }
  .day-detail-dot {
    width: 10px;
    height: 10px;
    border-radius: 2px;
    flex-shrink: 0;
    display: inline-block;
  }
  .day-detail-name {
    font-weight: 600;
    font-size: 0.9375rem;
  }
  .day-detail-type {
    font-size: 0.875rem;
    color: var(--text-muted);
  }
</style>

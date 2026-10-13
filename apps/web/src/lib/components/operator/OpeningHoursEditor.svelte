<!--
  OpeningHoursEditor - the seven-day opening hours of the operator salon form (Issue #89, D-10).

  One row per weekday, Montag (index 0) to Sonntag. A closed day hides its time inputs but keeps
  the times in the data, because the API requires valid strings for a closed day too. Errors come
  from the parent (validateOpeningHours) keyed by day index and render under their row.
-->
<script lang="ts">
  import { DAY_NAMES } from "$lib/operator/opening-hours";
  import type { OpeningHoursDay } from "$lib/operator/types";

  interface Props {
    days: OpeningHoursDay[];
    /** Problem text per day index; absent = no problem. */
    errors?: Record<number, string>;
  }

  let { days = $bindable(), errors = {} }: Props = $props();

  // Updates replace the array instead of mutating an entry, so they reach the parent's binding
  // whether or not the array it passed is reactive.
  function update(index: number, patch: Partial<OpeningHoursDay>) {
    days = days.map((entry, i) => (i === index ? { ...entry, ...patch } : entry));
  }
</script>

<fieldset class="hours" data-testid="op-salon-hours">
  <legend class="legend">Öffnungszeiten</legend>
  {#each days as entry, index (index)}
    {@const name = DAY_NAMES[index] ?? `Tag ${index + 1}`}
    {@const error = errors[index]}
    <div class="row" data-testid={`op-salon-hours-${index}`}>
      <label class="day">
        <input
          type="checkbox"
          checked={!entry.closed}
          data-testid={`op-salon-hours-${index}-open`}
          onchange={(event) => update(index, { closed: !event.currentTarget.checked })}
        />
        <span class="day-name">{name}</span>
        <span class="state">Geöffnet</span>
      </label>
      {#if entry.closed}
        <span class="closed" data-testid={`op-salon-hours-${index}-closed`}>Geschlossen</span>
      {:else}
        <input
          class="form-input time"
          type="time"
          aria-label={`${name} von`}
          aria-invalid={error ? "true" : undefined}
          aria-describedby={error ? `op-salon-hours-${index}-error` : undefined}
          data-testid={`op-salon-hours-${index}-from`}
          value={entry.open}
          oninput={(event) => update(index, { open: event.currentTarget.value })}
        />
        <input
          class="form-input time"
          type="time"
          aria-label={`${name} bis`}
          aria-invalid={error ? "true" : undefined}
          aria-describedby={error ? `op-salon-hours-${index}-error` : undefined}
          data-testid={`op-salon-hours-${index}-to`}
          value={entry.close}
          oninput={(event) => update(index, { close: event.currentTarget.value })}
        />
      {/if}
      {#if error}
        <p
          class="form-error problem"
          id={`op-salon-hours-${index}-error`}
          data-testid={`op-salon-hours-${index}-error`}
        >
          {error}
        </p>
      {/if}
    </div>
  {/each}
</fieldset>

<style>
  .hours {
    display: flex;
    flex-direction: column;
    gap: 12px;
    min-width: 0;
    margin: 0;
    padding: 16px 0 0;
    border: 0;
    border-top: 1px solid var(--border);
  }

  .legend {
    padding: 0;
    font-size: 13px;
    font-weight: 600;
    color: var(--text);
  }

  /* Narrow: day + checkbox on line one, von/bis share line two. */
  .row {
    display: grid;
    grid-template-columns: 1fr 1fr;
    gap: 8px;
    align-items: center;
    min-width: 0;
  }

  .day {
    grid-column: 1 / -1;
    display: flex;
    align-items: center;
    gap: 8px;
    flex-wrap: wrap;
    min-width: 0;
    font-size: 15px;
    color: var(--text);
  }

  .day input {
    flex-shrink: 0;
  }

  .day-name {
    min-width: 5.5em;
  }

  .state {
    font-size: 13px;
    color: var(--text-muted);
  }

  .closed {
    grid-column: 1 / -1;
    font-size: 13px;
    color: var(--text-muted);
  }

  .time {
    min-width: 0;
    font-variant-numeric: tabular-nums;
  }

  .problem {
    grid-column: 1 / -1;
    margin: 0;
    overflow-wrap: anywhere;
  }

  @media (min-width: 480px) {
    .row {
      grid-template-columns: minmax(112px, 1fr) 1fr 1fr;
    }

    .day {
      grid-column: auto;
    }

    .closed {
      grid-column: 2 / -1;
    }
  }
</style>

<!--
  OpeningHoursEditor — the tenant week editor for a salon's opening hours (Issue #563).

  One row per weekday: a "Geschlossen" checkbox and the opening / closing time. The component
  edits the bound week in place and validates nothing itself — the page calls
  `validateOpeningHours()` before it saves and passes the messages back through `errors`
  (keyed by `OpeningHoursDay.day`). Tenant-only: the operator console keeps its own editor.

  Props:
    days     — bindable, the seven rows (0 = Montag … 6 = Sonntag)
    disabled — read-only presentation (a reader without `salon:manage`)
    errors   — German message per day, shown under the row and tied with aria-describedby
    idPrefix — unique id prefix when several editors share a page
-->
<script lang="ts">
  import { WEEKDAY_LABELS, type OpeningHoursDay } from "$lib/salons/opening-hours";

  interface Props {
    days: OpeningHoursDay[];
    disabled?: boolean;
    errors?: Record<number, string>;
    idPrefix?: string;
  }

  let { days = $bindable(), disabled = false, errors = {}, idPrefix = "ohe" }: Props = $props();

  function setRow(idx: number, patch: Partial<OpeningHoursDay>) {
    days[idx] = { ...days[idx], ...patch };
  }
</script>

<div class="ohe" role="group" aria-label="Öffnungszeiten je Wochentag">
  <div class="ohe-row ohe-row--head" aria-hidden="true">
    <div>Wochentag</div>
    <div>Geschlossen</div>
    <div>Öffnung</div>
    <div>Schließung</div>
  </div>
  {#each days as entry, idx (entry.day)}
    {@const label = WEEKDAY_LABELS[entry.day]}
    {@const errorId = `${idPrefix}-error-${entry.day}`}
    <div class="ohe-row" class:ohe-row--invalid={Boolean(errors[entry.day])}>
      <div class="ohe-day">{label}</div>
      <div class="ohe-closed">
        <input
          id="{idPrefix}-closed-{entry.day}"
          type="checkbox"
          checked={entry.closed ?? false}
          {disabled}
          onchange={(e) => setRow(idx, { closed: e.currentTarget.checked })}
        />
        <label class="ohe-closed-label" for="{idPrefix}-closed-{entry.day}">
          Geschlossen {label}
        </label>
      </div>
      <div class="ohe-time">
        <label class="ohe-time-label" for="{idPrefix}-open-{entry.day}">Öffnung {label}</label>
        <input
          id="{idPrefix}-open-{entry.day}"
          class="form-input"
          type="time"
          value={entry.open}
          disabled={disabled || (entry.closed ?? false)}
          aria-invalid={errors[entry.day] ? "true" : undefined}
          aria-describedby={errors[entry.day] ? errorId : undefined}
          onchange={(e) => setRow(idx, { open: e.currentTarget.value })}
        />
      </div>
      <div class="ohe-time">
        <label class="ohe-time-label" for="{idPrefix}-close-{entry.day}">Schließung {label}</label>
        <input
          id="{idPrefix}-close-{entry.day}"
          class="form-input"
          type="time"
          value={entry.close}
          disabled={disabled || (entry.closed ?? false)}
          aria-invalid={errors[entry.day] ? "true" : undefined}
          aria-describedby={errors[entry.day] ? errorId : undefined}
          onchange={(e) => setRow(idx, { close: e.currentTarget.value })}
        />
      </div>
      {#if errors[entry.day]}
        <p id={errorId} class="form-error ohe-error" role="alert">{errors[entry.day]}</p>
      {/if}
    </div>
  {/each}
</div>

<style>
  .ohe {
    display: flex;
    flex-direction: column;
    gap: 4px;
    margin: 14px 0;
  }
  .ohe-row {
    display: grid;
    grid-template-columns: 1.5fr 0.8fr 1fr 1fr;
    align-items: center;
    gap: 12px;
    padding: 8px 4px;
    border-bottom: 1px solid var(--border);
    font-size: 14px;
  }
  .ohe-row--head {
    font-size: 12.5px;
    font-weight: 600;
    color: var(--text-muted);
    text-transform: uppercase;
    letter-spacing: 0.04em;
  }
  .ohe-row:last-child {
    border-bottom: none;
  }
  .ohe-row--invalid {
    background: var(--bad-soft);
  }
  .ohe-day {
    font-weight: 600;
    color: var(--text);
  }
  .ohe-closed {
    display: flex;
    align-items: center;
    gap: 8px;
  }
  /* Wide layout: the column headers name the controls, so the per-control captions are
     visually hidden but stay in the accessibility tree. */
  .ohe-time-label,
  .ohe-closed-label {
    position: absolute;
    width: 1px;
    height: 1px;
    overflow: hidden;
    clip-path: inset(50%);
    white-space: nowrap;
  }
  .ohe-error {
    grid-column: 1 / -1;
    margin: 0;
  }

  /* Narrow viewports (360 px phones): label line first, then checkbox and the two time inputs. */
  @media (max-width: 480px) {
    .ohe-row--head {
      display: none;
    }
    .ohe-row {
      grid-template-columns: 1fr 1fr;
      gap: 8px 12px;
    }
    .ohe-day {
      grid-column: 1 / -1;
    }
    .ohe-closed {
      grid-column: 1 / -1;
    }
    .ohe-time {
      display: flex;
      flex-direction: column;
      gap: 4px;
      min-width: 0;
    }
    .ohe-time-label,
    .ohe-closed-label {
      position: static;
      width: auto;
      height: auto;
      overflow: visible;
      clip-path: none;
      white-space: normal;
      font-size: 12.5px;
      color: var(--text-muted);
      cursor: pointer;
    }
  }
</style>

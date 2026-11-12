<!--
  OpeningHoursEditor — the tenant week editor for a salon's opening hours (Issue #563, rebuilt on
  the blocks of #843 by Issue #854).

  A `.settings-group` „Öffnungszeiten“ with one row per weekday: a „Geschlossen“ checkbox and the
  opening / closing time as FormFields. The component edits the bound week in place and validates
  nothing itself — the page validates (`validateOpeningHours()`) and passes the messages back
  through `errors` (keyed by `OpeningHoursDay.day`). Tenant-only: the operator console keeps its
  own editor.

  The section has its own SaveBar when the page passes `onSave`: the page owns the PATCH and its
  rules (docs/ADMIN_STRUCTURE.md §3.2.1, one button per section); the bar only shows the count.

  Props:
    days      — bindable, the seven rows (0 = Montag … 6 = Sonntag)
    disabled  — read-only presentation (a reader without `salon:manage`)
    errors    — German message per day, shown under the row and tied with aria-describedby
    idPrefix  — unique id prefix when several editors share a page
    changes   — number of unsaved changes (the SaveBar is hidden at 0)
    saving    — a save is running
    saveLabel — what the save does
    onSave / onDiscard — without `onSave` the section has no SaveBar
-->
<script lang="ts">
  import FormField from "$components/ui/FormField.svelte";
  import SaveBar from "$components/ui/SaveBar.svelte";
  import { WEEKDAY_LABELS, type OpeningHoursDay } from "$lib/salons/opening-hours";

  interface Props {
    days: OpeningHoursDay[];
    disabled?: boolean;
    errors?: Record<number, string>;
    idPrefix?: string;
    changes?: number;
    saving?: boolean;
    saveLabel?: string;
    onSave?: () => void;
    onDiscard?: () => void;
  }

  let {
    days = $bindable(),
    disabled = false,
    errors = {},
    idPrefix = "ohe",
    changes = 0,
    saving = false,
    saveLabel = "Öffnungszeiten speichern",
    onSave,
    onDiscard,
  }: Props = $props();

  const errorCount = $derived(Object.values(errors).filter(Boolean).length);

  function setRow(idx: number, patch: Partial<OpeningHoursDay>) {
    days[idx] = { ...days[idx], ...patch };
  }

  /** The describedby list of a time input: the field's own ids plus the row's error line. */
  function describedBy(own: string | undefined, errorId: string | undefined): string | undefined {
    const ids = [own, errorId].filter(Boolean);
    return ids.length > 0 ? ids.join(" ") : undefined;
  }
</script>

<section class="settings-group" aria-labelledby="{idPrefix}-title">
  <h2 class="settings-group-title" id="{idPrefix}-title">Öffnungszeiten</h2>
  <p class="settings-group-desc">
    Wochentägliche Öffnungs- und Schließzeiten dieses Salons. Die Schichtplanung prüft Schichten
    gegen diese Zeiten.
  </p>

  <div class="ohe" role="group" aria-label="Öffnungszeiten je Wochentag">
    {#each days as entry, idx (entry.day)}
      {@const label = WEEKDAY_LABELS[entry.day]}
      {@const errorId = errors[entry.day] ? `${idPrefix}-error-${entry.day}` : undefined}
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
          <label class="ohe-closed-label" for="{idPrefix}-closed-{entry.day}"
            >Geschlossen <span class="sr-only">{label}</span></label
          >
        </div>
        <!-- The visible label says what the field is; the aria-label adds the weekday for the
             screen reader (it starts with the visible text, WCAG 2.5.3). -->
        <FormField label="Öffnung">
          {#snippet field({ id, describedBy: own, invalid })}
            <input
              {id}
              class="form-input"
              type="time"
              value={entry.open}
              disabled={disabled || (entry.closed ?? false)}
              aria-label="Öffnung {label}"
              aria-invalid={invalid || errorId ? "true" : undefined}
              aria-describedby={describedBy(own, errorId)}
              onchange={(e) => setRow(idx, { open: e.currentTarget.value })}
            />
          {/snippet}
        </FormField>
        <FormField label="Schließung">
          {#snippet field({ id, describedBy: own, invalid })}
            <input
              {id}
              class="form-input"
              type="time"
              value={entry.close}
              disabled={disabled || (entry.closed ?? false)}
              aria-label="Schließung {label}"
              aria-invalid={invalid || errorId ? "true" : undefined}
              aria-describedby={describedBy(own, errorId)}
              onchange={(e) => setRow(idx, { close: e.currentTarget.value })}
            />
          {/snippet}
        </FormField>
        {#if errorId}
          <p id={errorId} class="ohe-error" role="alert">{errors[entry.day]}</p>
        {/if}
      </div>
    {/each}
  </div>

  {#if onSave && !disabled}
    <SaveBar
      {changes}
      errors={errorCount}
      {saving}
      {saveLabel}
      {onSave}
      onDiscard={() => onDiscard?.()}
    />
  {/if}
</section>

<style>
  .ohe {
    display: flex;
    flex-direction: column;
    max-width: 44rem;
  }
  /* A row is one line of four cells while there is room and wraps into two lines of two cells on
     a phone (day and checkbox, then the two times) - auto-fit, no viewport or container query. */
  .ohe-row {
    display: grid;
    grid-template-columns: repeat(auto-fit, minmax(8rem, 1fr));
    align-items: end;
    gap: var(--s-2) var(--s-3);
    padding: var(--s-2) var(--s-1);
    border-bottom: 1px solid var(--line);
    font-size: var(--fs-base);
  }
  .ohe-row:last-child {
    border-bottom: none;
  }
  .ohe-row--invalid {
    background: var(--bad-soft);
  }
  .ohe-day {
    align-self: center;
    font-weight: 600;
    color: var(--text);
  }
  .ohe-closed {
    align-self: center;
    display: flex;
    align-items: center;
    gap: var(--s-2);
  }
  .ohe-closed-label {
    cursor: pointer;
  }
  .ohe-error {
    grid-column: 1 / -1;
    margin: 0;
    font-size: var(--fs-sm);
    color: var(--bad);
  }
</style>

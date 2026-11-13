<script lang="ts">
  // Issue #612 (D-612-1) rebuilt on the blocks for Issue #854: choose a period of up to twelve whole
  // months - the five presets, or „Von“ and „Bis“ as month and year. The dialog validates with
  // `validateRange` (the same rule the URL parser clamps with), applies through `onApply` and owns
  // no URL and no navigation. It is the one place presets live since the period bar is a
  // PeriodPicker (arrows and zoom only).
  import { untrack } from "svelte";
  import Dialog from "$components/ui/Dialog.svelte";
  import FormField from "$components/ui/FormField.svelte";
  import Note from "$components/ui/Note.svelte";
  import type { YearMonth } from "$lib/reports/period-report";
  import {
    activePreset,
    type PresetKey,
    MONTH_NAMES_DE,
    presetPeriods,
    RANGE_ERROR_TEXT,
    validateRange,
  } from "$lib/reports/period-state";

  interface Props {
    /** Two-way bindable open state. */
    open: boolean;
    /** The period currently shown; the selects start from it every time the dialog opens. */
    from: YearMonth;
    to: YearMonth;
    /** Tenant-local current month. */
    today: YearMonth;
    onApply: (from: YearMonth, to: YearMonth) => void;
  }

  let { open = $bindable(), from, to, today, onApply }: Props = $props();

  let fromMonth = $state(1);
  let fromYear = $state(2000);
  let toMonth = $state(1);
  let toYear = $state(2000);

  const presets = $derived(presetPeriods(today));
  // Issue #781: exactly one preset is pressed; the clicked one wins while it still matches.
  let clickedPreset: PresetKey | null = $state(null);
  const pressed = $derived(activePreset(from, to, today, clickedPreset));
  const autofocusPreset = $derived(pressed ?? presets[0].key);
  const years = $derived(Array.from({ length: 11 }, (_, i) => today.year - 10 + i));
  const error = $derived(
    validateRange({ year: fromYear, month: fromMonth }, { year: toYear, month: toMonth }, today),
  );

  // Reset the selects from the current period whenever the dialog opens.
  $effect(() => {
    if (!open) return;
    untrack(() => {
      fromMonth = from.month;
      fromYear = from.year;
      toMonth = to.month;
      toYear = to.year;
    });
  });

  function apply() {
    if (error) return;
    clickedPreset = null;
    onApply({ year: fromYear, month: fromMonth }, { year: toYear, month: toMonth });
    open = false;
  }

  function applyPreset(key: PresetKey, start: YearMonth, end: YearMonth) {
    clickedPreset = key;
    onApply(start, end);
    open = false;
  }
</script>

<Dialog bind:open eyebrow="Berichte" title="Zeitraum wählen">
  <section class="range-presets" aria-labelledby="range-presets-title">
    <h4 id="range-presets-title" class="range-section-title">Schnellauswahl</h4>
    <div class="range-preset-list">
      {#each presets as preset (preset.key)}
        <button
          type="button"
          class="btn btn-secondary"
          class:is-active={pressed === preset.key}
          aria-pressed={pressed === preset.key}
          data-autofocus={preset.key === autofocusPreset ? "" : undefined}
          onclick={() => applyPreset(preset.key, preset.from, preset.to)}>{preset.label}</button
        >
      {/each}
    </div>
  </section>

  <div class="range-fields">
    <fieldset class="range-fieldset">
      <legend class="range-section-title">Von</legend>
      <div class="range-selects">
        <FormField label="Monat">
          {#snippet field({ id })}
            <select {id} bind:value={fromMonth}>
              {#each MONTH_NAMES_DE as name, i (name)}
                <option value={i + 1}>{name}</option>
              {/each}
            </select>
          {/snippet}
        </FormField>
        <FormField label="Jahr">
          {#snippet field({ id })}
            <select {id} bind:value={fromYear}>
              {#each years as year (year)}
                <option value={year}>{year}</option>
              {/each}
            </select>
          {/snippet}
        </FormField>
      </div>
    </fieldset>

    <fieldset class="range-fieldset">
      <legend class="range-section-title">Bis</legend>
      <div class="range-selects">
        <FormField label="Monat">
          {#snippet field({ id })}
            <select {id} bind:value={toMonth}>
              {#each MONTH_NAMES_DE as name, i (name)}
                <option value={i + 1}>{name}</option>
              {/each}
            </select>
          {/snippet}
        </FormField>
        <FormField label="Jahr">
          {#snippet field({ id })}
            <select {id} bind:value={toYear}>
              {#each years as year (year)}
                <option value={year}>{year}</option>
              {/each}
            </select>
          {/snippet}
        </FormField>
      </div>
    </fieldset>
  </div>

  {#if error}
    <div class="range-error" role="alert">
      <Note tone="bad">{RANGE_ERROR_TEXT[error]}</Note>
    </div>
  {/if}

  {#snippet footer()}
    <button type="button" class="btn btn-ghost" onclick={() => (open = false)}>Abbrechen</button>
    <button type="button" class="btn btn-primary" disabled={error !== null} onclick={apply}
      >Zeitraum übernehmen</button
    >
  {/snippet}
</Dialog>

<style>
  .range-section-title {
    margin: 0 0 var(--s-2);
    padding: 0;
    font-size: var(--fs-base);
    font-weight: 600;
    line-height: 1.3;
    color: var(--text);
  }

  .range-presets {
    margin-bottom: var(--s-4);
  }

  .range-preset-list {
    display: flex;
    flex-wrap: wrap;
    gap: var(--s-2);
  }

  .range-preset-list .btn.is-active {
    background: var(--brand-soft);
    border-color: var(--brand);
    color: var(--text);
    font-weight: 600;
  }

  .range-fields {
    display: grid;
    grid-template-columns: 1fr 1fr;
    gap: var(--s-4);
  }

  .range-fieldset {
    min-width: 0;
    margin: 0;
    padding: 0;
    border: 0;
  }

  .range-selects {
    display: grid;
    grid-template-columns: 1.4fr 1fr;
    gap: var(--s-2);
  }

  .range-error {
    margin: var(--s-3) 0 0;
  }

  @media (max-width: 480px) {
    .range-fields {
      grid-template-columns: 1fr;
    }
  }

  @media (pointer: coarse) {
    .range-preset-list .btn {
      min-height: 44px;
    }
  }
</style>

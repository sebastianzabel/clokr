<script lang="ts">
  // Issue #612 (D-612-1, UI-SPEC "„Zeitraum wählen“ dialog") — choose a period of up to twelve
  // whole months. The dialog validates with `validateRange` (the same rule the URL parser clamps
  // with), applies through `onApply` and owns no URL and no navigation.
  import { untrack } from "svelte";
  import Modal from "$components/ui/Modal.svelte";
  import type { YearMonth } from "$lib/reports/period-report";
  import {
    activePresets,
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
  // Decided once per opening: the narrow layout lists the presets and focuses one of them.
  let narrow = $state(false);

  const presets = $derived(presetPeriods(today));
  const pressed = $derived(activePresets(from, to, today));
  const autofocusPreset = $derived(pressed[0] ?? presets[0].key);
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
      narrow =
        typeof window !== "undefined" &&
        typeof window.matchMedia === "function" &&
        window.matchMedia("(max-width: 960px)").matches;
    });
  });

  function apply() {
    if (error) return;
    onApply({ year: fromYear, month: fromMonth }, { year: toYear, month: toMonth });
    open = false;
  }

  function applyPreset(start: YearMonth, end: YearMonth) {
    onApply(start, end);
    open = false;
  }
</script>

<Modal bind:open eyebrow="Berichte" title="Zeitraum wählen">
  <section class="range-presets" aria-labelledby="range-presets-title">
    <h4 id="range-presets-title" class="range-section-title">Schnellauswahl</h4>
    <div class="range-preset-list">
      {#each presets as preset (preset.key)}
        <button
          type="button"
          class="btn btn-outline"
          class:is-active={pressed.includes(preset.key)}
          aria-pressed={pressed.includes(preset.key)}
          data-autofocus={narrow && preset.key === autofocusPreset ? "" : undefined}
          onclick={() => applyPreset(preset.from, preset.to)}>{preset.label}</button
        >
      {/each}
    </div>
  </section>

  <div class="range-fields">
    <fieldset class="range-fieldset">
      <legend class="range-section-title">Von</legend>
      <div class="range-selects">
        <div>
          <label class="form-label" for="range-from-month">Monat</label>
          <select
            id="range-from-month"
            class="form-input"
            bind:value={fromMonth}
            data-autofocus={narrow ? undefined : ""}
          >
            {#each MONTH_NAMES_DE as name, i (name)}
              <option value={i + 1}>{name}</option>
            {/each}
          </select>
        </div>
        <div>
          <label class="form-label" for="range-from-year">Jahr</label>
          <select id="range-from-year" class="form-input" bind:value={fromYear}>
            {#each years as year (year)}
              <option value={year}>{year}</option>
            {/each}
          </select>
        </div>
      </div>
    </fieldset>

    <fieldset class="range-fieldset">
      <legend class="range-section-title">Bis</legend>
      <div class="range-selects">
        <div>
          <label class="form-label" for="range-to-month">Monat</label>
          <select id="range-to-month" class="form-input" bind:value={toMonth}>
            {#each MONTH_NAMES_DE as name, i (name)}
              <option value={i + 1}>{name}</option>
            {/each}
          </select>
        </div>
        <div>
          <label class="form-label" for="range-to-year">Jahr</label>
          <select id="range-to-year" class="form-input" bind:value={toYear}>
            {#each years as year (year)}
              <option value={year}>{year}</option>
            {/each}
          </select>
        </div>
      </div>
    </fieldset>
  </div>

  {#if error}
    <p class="form-error range-error" role="alert">{RANGE_ERROR_TEXT[error]}</p>
  {/if}

  {#snippet footer()}
    <button type="button" class="btn btn-ghost" onclick={() => (open = false)}>Abbrechen</button>
    <button type="button" class="btn btn-primary" disabled={error !== null} onclick={apply}
      >Zeitraum übernehmen</button
    >
  {/snippet}
</Modal>

<style>
  .range-section-title {
    margin: 0 0 var(--s-2);
    padding: 0;
    font-size: 15px;
    font-weight: 600;
    line-height: 1.3;
    color: var(--text);
  }

  /* The presets are the narrow-viewport entry; wide screens have them in the bar. */
  .range-presets {
    display: none;
    margin-bottom: var(--s-4);
  }

  .range-preset-list {
    display: flex;
    flex-direction: column;
    gap: var(--s-2);
  }

  .range-preset-list .btn {
    width: 100%;
  }

  .range-preset-list .btn.is-active {
    background: var(--brand-soft);
    border-color: var(--brand-light);
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
    font-size: 12px;
    line-height: 1.4;
  }

  @media (max-width: 960px) {
    .range-presets {
      display: block;
    }
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

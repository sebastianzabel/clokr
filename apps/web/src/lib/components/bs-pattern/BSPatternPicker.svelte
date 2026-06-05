<!--
  BSPatternPicker — Phase 76-03 (extracted from Phase 67 inline editor)

  Minimal-contract picker for the BS-Pattern (Berufsschule) draft used by
  admin/employees/[id]. Two modes:

    weekly  → workDays[] is the source of truth; blockYear MUST be null
    block   → blockYear is the source of truth; workDays MUST be []

  The mode-switch payload guard auto-clears the inactive-side data so the
  caller never accidentally persists stale fields. This was a bug-prone
  corner of the inline implementation (67-02-SUMMARY).

  This extracted picker covers ONLY the validation surface tested in
  76-03. The richer fields composed by the inline editor (validFrom,
  validUntil, schoolHolidays, bsBundesland, blockWeeks) remain in the
  admin route page until a future plan does the full hoist.
-->
<script lang="ts">
  // Types live in ./types.ts because Svelte 5's ambient *.svelte declaration
  // only exposes the default export to tsc — named module-block exports aren't
  // visible. Callers import the component (default) from here and the types
  // from `./types`. See BSPatternPicker.test.ts for the canonical pattern.
  import type { BSPatternMode, BSPatternDraft, BSPatternPickerProps } from "./types";

  let { draft, onChange }: BSPatternPickerProps = $props();

  // Sun-first labels mirror server-side WorkSchedule.workDays index convention
  // (0=Sun..6=Sat). The German abbreviations match the existing inline UI.
  const WEEKDAY_LABELS = ["So", "Mo", "Di", "Mi", "Do", "Fr", "Sa"];

  function setMode(mode: BSPatternMode) {
    if (mode === draft.mode) return;
    // Phase 67 invariant: switching modes clears the inactive-side payload.
    //   weekly → block : workDays = []   (no daily allocation when blockwise)
    //   block  → weekly: blockYear = null (no year when weekly)
    const next: BSPatternDraft =
      mode === "block" ? { ...draft, mode, workDays: [] } : { ...draft, mode, blockYear: null };
    onChange(next);
  }

  function toggleWorkDay(day: number) {
    const has = draft.workDays.includes(day);
    const workDays = has
      ? draft.workDays.filter((d) => d !== day)
      : [...draft.workDays, day].sort((a, b) => a - b);
    onChange({ ...draft, workDays });
  }

  function setBlockYear(year: number | null) {
    onChange({ ...draft, blockYear: year });
  }

  // Validation: drives save-button disabled state. Pure derived from draft.
  const canSave = $derived(
    draft.mode === "weekly"
      ? draft.workDays.length > 0
      : draft.blockYear !== null && draft.blockYear !== undefined,
  );
</script>

<div class="bs-pattern-picker" data-testid="bs-pattern-picker">
  <div class="bs-pattern-picker__mode" role="radiogroup" aria-label="Berufsschul-Modus">
    <button
      type="button"
      role="radio"
      aria-checked={draft.mode === "weekly"}
      class:bs-pattern-picker__mode-btn--active={draft.mode === "weekly"}
      data-testid="bs-mode-weekly"
      onclick={() => setMode("weekly")}
    >
      Wöchentlich
    </button>
    <button
      type="button"
      role="radio"
      aria-checked={draft.mode === "block"}
      class:bs-pattern-picker__mode-btn--active={draft.mode === "block"}
      data-testid="bs-mode-block"
      onclick={() => setMode("block")}
    >
      Blockunterricht
    </button>
  </div>

  {#if draft.mode === "weekly"}
    <div class="bs-pattern-picker__weekdays" data-testid="bs-workdays-grid">
      {#each WEEKDAY_LABELS as label, i (i)}
        <button
          type="button"
          class:bs-pattern-picker__weekday--selected={draft.workDays.includes(i)}
          data-testid={`bs-workday-${i}`}
          aria-pressed={draft.workDays.includes(i)}
          onclick={() => toggleWorkDay(i)}
        >
          {label}
        </button>
      {/each}
    </div>
  {:else}
    <div class="bs-pattern-picker__block" data-testid="bs-block-fields">
      <label>
        Jahr:
        <input
          type="number"
          data-testid="bs-block-year"
          value={draft.blockYear ?? ""}
          oninput={(e) => {
            const v = (e.currentTarget as HTMLInputElement).value;
            setBlockYear(v === "" ? null : Number(v));
          }}
        />
      </label>
    </div>
  {/if}

  <button type="button" data-testid="bs-save-btn" disabled={!canSave}> Speichern </button>
</div>

<style>
  .bs-pattern-picker__mode {
    display: flex;
    gap: 0.5rem;
    margin-bottom: 1rem;
  }
  .bs-pattern-picker__weekdays {
    display: grid;
    grid-template-columns: repeat(7, 1fr);
    gap: 0.25rem;
  }
  .bs-pattern-picker__weekday--selected {
    background: var(--brand);
    color: var(--brand-fg);
  }
  .bs-pattern-picker__mode-btn--active {
    font-weight: 600;
    border-bottom: 2px solid var(--brand);
  }
</style>

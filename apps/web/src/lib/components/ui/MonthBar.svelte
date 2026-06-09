<script lang="ts">
  import type { Snippet } from "svelte";

  export type MonthBarStat = {
    label: string;
    value: string;
    unit?: string;
    /** Optional tone modifier — "pos" (good) or "neg" (bad). */
    tone?: "pos" | "neg";
  };

  interface Props {
    /** Optional serif italic eyebrow above the month label (e.g. "Buchungsmonat"). */
    eyebrow?: string;
    /** Cursor date — component derives "März 2026" label via Intl.DateTimeFormat('de-DE'). */
    date: Date;
    /** Mini-stat cluster rendered on the right side of the bar. */
    stats?: MonthBarStat[];
    /** Navigate to previous month. */
    onPrev: () => void;
    /** Navigate to next month. */
    onNext: () => void;
    /** Optional "Heute" jump — button only renders when provided. */
    onToday?: () => void;
    /**
     * Optional month/year picker callback. When provided, the month label
     * renders as a clickable button (with chevron) that opens a grid dropdown
     * matching the `.cal-monthbar` pattern used on /leave + /team/leave.
     */
    onSelectMonth?: (month: number, year: number) => void;
    /** Optional extra trailing actions slot (e.g. PDF export button). */
    extraActions?: Snippet;
    /**
     * Test-id surface prefix (Phase 73-03, D-05). The primitive emits
     * `{prefix}`, `{prefix}-prev`, `{prefix}-next`, `{prefix}-today`,
     * `{prefix}-label`. Pages override per surface, e.g. "calendar-month-header"
     * on Zeiterfassung. Default keeps existing month-bar surface.
     */
    testIdPrefix?: string;
  }

  let {
    eyebrow,
    date,
    stats = [],
    onPrev,
    onNext,
    onToday,
    onSelectMonth,
    extraActions,
    testIdPrefix = "month-bar",
  }: Props = $props();

  const monthLabel = $derived(
    new Intl.DateTimeFormat("de-DE", { month: "long", year: "numeric" }).format(date),
  );

  // ── Optional month-picker dropdown (matches .cal-monthbar pattern) ──
  const MONTH_NAMES_SHORT = [
    "Jan",
    "Feb",
    "Mär",
    "Apr",
    "Mai",
    "Jun",
    "Jul",
    "Aug",
    "Sep",
    "Okt",
    "Nov",
    "Dez",
  ];
  let showPicker = $state(false);
  let pickerYear = $state(date.getFullYear());
  const currentMonth = $derived(date.getMonth() + 1);
  const currentYear = $derived(date.getFullYear());

  function togglePicker() {
    pickerYear = currentYear;
    showPicker = !showPicker;
  }
  function selectMonth(m: number, y: number) {
    showPicker = false;
    onSelectMonth?.(m, y);
  }
  function todayClicked() {
    showPicker = false;
    onToday?.();
  }
</script>

<!-- Month navigation bar primitive (D-02). Encapsulates the v1.5 .month-bar recipe.
     The primitive does NOT include `.card` because consumers typically wrap it
     in `<Card>` themselves (compositional). When used standalone, wrap in Card. -->
<div class="month-bar" data-testid={testIdPrefix}>
  <div class="month-bar-nav">
    <button
      class="nav-btn"
      onclick={onPrev}
      title="Vorheriger Monat"
      aria-label="Vorheriger Monat"
      data-testid={`${testIdPrefix}-prev`}
    >
      <svg
        width="18"
        height="18"
        viewBox="0 0 24 24"
        fill="none"
        stroke="currentColor"
        stroke-width="2.5"><polyline points="15 18 9 12 15 6" /></svg
      >
    </button>
    <div class="month-bar-center">
      {#if eyebrow}
        <div class="month-bar-eyebrow">{eyebrow}</div>
      {/if}
      {#if onSelectMonth}
        <button
          type="button"
          class="month-bar-label month-bar-label--picker"
          onclick={togglePicker}
          title="Monat/Jahr wählen"
          data-testid={`${testIdPrefix}-label`}
        >
          {monthLabel}
          <svg
            width="12"
            height="12"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            stroke-width="2.5"
            aria-hidden="true"><polyline points="6 9 12 15 18 9" /></svg
          >
        </button>
        {#if showPicker}
          <!-- svelte-ignore a11y_no_static_element_interactions -->
          <div class="month-picker-backdrop" onclick={() => (showPicker = false)}></div>
          <div class="month-picker" data-testid={`${testIdPrefix}-picker`}>
            <div class="month-picker-year">
              <button type="button" onclick={() => pickerYear--} aria-label="Jahr zurück">‹</button>
              <span>{pickerYear}</span>
              <button type="button" onclick={() => pickerYear++} aria-label="Jahr vor">›</button>
            </div>
            <div class="month-picker-grid">
              {#each MONTH_NAMES_SHORT as name, i (i)}
                <button
                  type="button"
                  class="month-picker-btn"
                  class:active={i + 1 === currentMonth && pickerYear === currentYear}
                  onclick={() => selectMonth(i + 1, pickerYear)}>{name}</button
                >
              {/each}
            </div>
            {#if onToday}
              <button type="button" class="month-picker-today" onclick={todayClicked}>Heute</button>
            {/if}
          </div>
        {/if}
      {:else}
        <div class="month-bar-label" data-testid={`${testIdPrefix}-label`}>{monthLabel}</div>
      {/if}
    </div>
    <button
      class="nav-btn"
      onclick={onNext}
      title="Nächster Monat"
      aria-label="Nächster Monat"
      data-testid={`${testIdPrefix}-next`}
    >
      <svg
        width="18"
        height="18"
        viewBox="0 0 24 24"
        fill="none"
        stroke="currentColor"
        stroke-width="2.5"><polyline points="9 18 15 12 9 6" /></svg
      >
    </button>
    {#if onToday}
      <button
        class="btn btn-ghost btn-sm month-bar-today"
        onclick={onToday}
        data-testid={`${testIdPrefix}-today`}>Heute</button
      >
    {/if}
    {#if extraActions}
      <div class="month-bar-extra">{@render extraActions()}</div>
    {/if}
  </div>
  {#if stats.length}
    <div class="month-bar-stats" data-testid={`${testIdPrefix}-stats`}>
      {#each stats as s (s.label)}
        <div class="mstat" data-testid={`${testIdPrefix}-stat-${s.label}`}>
          <div class="mstat-label">{s.label}</div>
          <div class="mstat-value" class:pos={s.tone === "pos"} class:neg={s.tone === "neg"}>
            {s.value}{#if s.unit}<span class="mstat-unit">{s.unit}</span>{/if}
          </div>
        </div>
      {/each}
    </div>
  {/if}
</div>

<style>
  /* ── Combined Month-Bar (v1.5 — nav + mini-stats in one .card) ─────
     Dimensions kept in lockstep with .cal-monthbar (app.css) so /leave,
     /team/leave, /teamcal, /time-entries and /team/time-entries share
     the same header height + serif title. Consumers must set the wrapping
     .card padding to 0 so the primitive owns the inner spacing. */
  .month-bar {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 24px;
    flex-wrap: nowrap;
    padding: 18px 24px;
  }

  .month-bar > .month-bar-nav {
    min-width: 0;
    flex: 0 1 auto;
  }

  .month-bar > .month-bar-stats {
    min-width: 0;
    flex: 0 0 auto;
  }

  /* Only allow wrap on truly narrow viewports (phone landscape). */
  @media (max-width: 640px) {
    .month-bar {
      flex-wrap: wrap;
    }
  }

  .month-bar-nav {
    display: flex;
    align-items: center;
    gap: 8px;
    flex-wrap: nowrap;
  }

  .month-bar-center {
    display: flex;
    flex-direction: column;
    align-items: center;
    min-width: 200px;
    text-align: center;
    position: relative;
  }

  .month-bar-eyebrow {
    font-family: var(--font-serif);
    font-style: italic;
    color: var(--brand-light, var(--brand));
    font-size: 13px;
    line-height: 1;
    margin-bottom: 4px;
  }

  .month-bar-label {
    font-family: var(--font-serif);
    font-weight: 400;
    font-size: 26px;
    line-height: 1.1;
    letter-spacing: 0.005em;
    color: var(--text);
    text-transform: capitalize;
    min-width: 9ch;
    text-align: center;
    white-space: nowrap;
  }

  /* Picker-trigger variant: matches .cal-monthbar-title look — chevron, hover. */
  .month-bar-label--picker {
    display: inline-flex;
    align-items: center;
    gap: 6px;
    background: none;
    border: 0;
    cursor: pointer;
    padding: 2px 4px;
    border-radius: var(--r-sm);
    transition: color 0.15s ease;
  }
  .month-bar-label--picker:hover {
    color: var(--brand-light, var(--brand));
  }
  .month-bar-label--picker :global(svg) {
    color: var(--text-muted);
  }

  .month-bar-today {
    margin-left: 4px;
  }

  .month-bar-extra {
    margin-left: auto;
    display: flex;
    gap: 8px;
    align-items: center;
  }

  /* ── Mini-stats cluster ──────────────────────────────────────────── */
  .month-bar-stats {
    display: flex;
    align-items: flex-end;
    gap: 14px;
    flex-wrap: nowrap;
  }

  .mstat {
    display: flex;
    flex-direction: column;
    gap: 4px;
    min-width: 0;
    white-space: nowrap;
  }

  .mstat-label {
    font-size: 10.5px;
    font-weight: 600;
    letter-spacing: 0.12em;
    text-transform: uppercase;
    color: var(--text-faint);
    white-space: nowrap;
  }

  .mstat-value {
    font-family: var(--font-serif);
    font-variant-numeric: tabular-nums;
    font-size: 19px;
    font-weight: 400;
    color: var(--text);
    line-height: 1;
    display: inline-flex;
    align-items: baseline;
    gap: 4px;
    white-space: nowrap;
  }

  .mstat-value.pos {
    color: var(--good);
  }

  .mstat-value.neg {
    color: var(--bad);
  }

  .mstat-unit {
    font-family: var(--font-sans);
    font-variant-numeric: normal;
    font-size: 12px;
    font-weight: 500;
    color: var(--text-muted);
  }
</style>

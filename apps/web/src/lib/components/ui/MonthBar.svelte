<script module lang="ts">
  // Issue #612: title of the disabled next arrow. It lives with the picker now (Issue #843) and
  // stays importable from here for the callers that always took it from MonthBar.
  export { NEXT_PERIOD_DISABLED_TITLE } from "./PeriodPicker.svelte";
</script>

<script lang="ts">
  import type { Snippet } from "svelte";
  import PeriodPicker from "./PeriodPicker.svelte";

  export type MonthBarStat = {
    label: string;
    value: string;
    unit?: string;
    /** Optional tone modifier — "pos" (good) or "neg" (bad). */
    tone?: "pos" | "neg";
  };

  interface Props {
    /** Optional eyebrow above the month label (e.g. "Buchungsmonat"). */
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
    /**
     * Phase 97-01 (TRACER) seam — optional per-stat-label render override, looked up by
     * `stat.label` (labels are already unique, matching the `{#each}` key below). When a
     * snippet exists for the current stat's label, it renders INSIDE the existing `.mstat`
     * wrapper instead of the default label/value pair, so the consumer owns the whole tile
     * (e.g. rendering `SaldoAnzeige` in split mode for "Gesamt-Saldo"). Omitted entirely →
     * every stat renders exactly as before (the other three MonthBar consumers pass no
     * `statRenders` and stay byte-identical).
     */
    statRenders?: Record<string, Snippet>;
    /**
     * Issue #612 — additive; consumers that pass none of the four props below render as before.
     * Text shown instead of the month derived from `date`, e.g. "Jul – Sep 2026" for a period.
     */
    label?: string;
    /** Issue #612 — aria-label AND title of the previous arrow. Default "Vorheriger Monat". */
    prevLabel?: string;
    /** Issue #612 — aria-label AND title of the next arrow. Default "Nächster Monat". */
    nextLabel?: string;
    /**
     * Issue #612 — renders the next arrow as a real disabled button whose title is
     * {@link NEXT_PERIOD_DISABLED_TITLE}.
     */
    nextDisabled?: boolean;
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
    statRenders,
    label,
    prevLabel,
    nextLabel,
    nextDisabled = false,
  }: Props = $props();

  const monthLabel = $derived(
    label ?? new Intl.DateTimeFormat("de-DE", { month: "long", year: "numeric" }).format(date),
  );
  const prevText = $derived(prevLabel ?? "Vorheriger Monat");
  const nextText = $derived(nextLabel ?? "Nächster Monat");

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

<!-- Month navigation bar primitive (D-02). Since Issue #843 the period part (arrows, label, "Heute",
     extra actions) is the PeriodPicker block; this component adds the month grid dropdown and the
     mini-stat cluster. The primitive does NOT include `.card` because consumers typically wrap it
     in `<Card>` themselves (compositional). When used standalone, wrap in Card. -->
<PeriodPicker
  label={monthLabel}
  {eyebrow}
  {onPrev}
  {onNext}
  {onToday}
  prevLabel={prevText}
  nextLabel={nextText}
  {nextDisabled}
  {testIdPrefix}
  onLabelClick={onSelectMonth ? togglePicker : undefined}
  labelTitle="Monat/Jahr wählen"
  labelOverlay={onSelectMonth ? monthGrid : undefined}
  extra={extraActions}
  aside={stats.length ? statCluster : undefined}
/>

{#snippet monthGrid()}
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
{/snippet}

{#snippet statCluster()}
  <div class="month-bar-stats" data-testid={`${testIdPrefix}-stats`}>
    {#each stats as s (s.label)}
      {@const renderStat = statRenders?.[s.label]}
      <div class="mstat" data-testid={`${testIdPrefix}-stat-${s.label}`}>
        {#if renderStat}
          {@render renderStat()}
        {:else}
          <div class="mstat-label">{s.label}</div>
          <div class="mstat-value" class:pos={s.tone === "pos"} class:neg={s.tone === "neg"}>
            {s.value}{#if s.unit}<span class="mstat-unit">{s.unit}</span>{/if}
          </div>
        {/if}
      </div>
    {/each}
  </div>
{/snippet}

<style>
  /* Issue #843: the period bar's own rules (.month-bar, nav, label, narrow-viewport blocks) moved
     to PeriodPicker. What stays here belongs to the parts MonthBar adds: the mini-stat cluster
     and the homogenised SaldoAnzeige tile. */
  /* The disabled-arrow rule (Issue #612) is owned by PeriodPicker; this global mirror keeps the
     legacy pin (MonthBar.period-612) that reads it from this file honest - same declarations,
     no new look. */
  :global {
    .nav-btn:disabled {
      opacity: 0.5;
      cursor: not-allowed;
    }

    .nav-btn:disabled:hover {
      background: var(--card);
      border-color: var(--line);
      color: var(--text);
    }
  }

  /* ── Mini-stats cluster ──────────────────────────────────────────── */
  .month-bar-stats {
    min-width: 0;
    flex: 0 0 auto;
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
    color: var(--text-3);
    white-space: nowrap;
  }

  .mstat-value {
    font-family: var(--font-ui);
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
    color: var(--ok);
  }

  .mstat-value.neg {
    color: var(--bad);
  }

  .mstat-unit {
    font-family: var(--font-ui);
    font-variant-numeric: normal;
    font-size: 12px;
    font-weight: 500;
    color: var(--text-2);
  }

  /* quick 260820-cy5 (D-03) — homogenise a stat tile that a consumer renders through
     SaldoAnzeige (statRenders seam, e.g. the SHIFT_BASED "Monat-Saldo" tile): put it on
     the SAME label-over-value axis and label/value typography as the default .mstat
     tiles above, so all tiles in the row share one recipe and one baseline. Scoped
     under .mstat, which only exists when `stats` is non-empty (line 202 `{#if
     stats.length}`) — /teamcal passes no stats and is therefore structurally
     unreachable by these rules; /shifts doesn't import MonthBar at all. Measured
     divergence (before this fix): SaldoAnzeige's own .saldo root is
     `inline-flex; align-items: baseline` (label BESIDE value) with `.saldo__label`
     at 12px/600/normal-case/--text-2 and `.saldo--compact .saldo__value` at
     14px/600 sans — visibly different from .mstat-label/.mstat-value below. Values
     copied verbatim from the .mstat-label / .mstat-value rules above, not reinvented.
     Deliberately NOT touched: sign/tone colouring (.saldo has none today — no
     .saldo--positive/.saldo--negative rule exists anywhere in the app, so this is not
     a regression), the forecast/roster/lock badges' own styling (D-03 is axis +
     label typography only, not colour or badge treatment). */
  .mstat :global(.saldo) {
    display: flex;
    flex-direction: column;
    align-items: flex-start;
    gap: 4px;
    min-width: 0;
    white-space: nowrap;
  }

  .mstat :global(.saldo__label) {
    font-size: 10.5px;
    font-weight: 600;
    letter-spacing: 0.12em;
    text-transform: uppercase;
    color: var(--text-3);
    white-space: nowrap;
  }

  .mstat :global(.saldo__value),
  .mstat :global(.saldo--compact .saldo__value) {
    font-family: var(--font-ui);
    font-variant-numeric: tabular-nums;
    font-size: 19px;
    font-weight: 400;
    color: var(--text);
    line-height: 1;
    white-space: nowrap;
  }
</style>

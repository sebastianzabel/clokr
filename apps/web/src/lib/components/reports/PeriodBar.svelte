<script lang="ts">
  // Issue #612 (D-612-1, D-612-6, UI-SPEC "Period bar") — the ONE period control of /reports:
  // ◀ label ▶ (MonthBar with the month picker), five presets, "Zeitraum…" and — only for callers
  // who may export — "Exportieren". It owns no URL and no navigation: the page passes `onChange`.
  import Icon from "$components/Icon.svelte";
  import MonthBar from "$components/ui/MonthBar.svelte";
  import Spinner from "$components/ui/Spinner.svelte";
  import type { YearMonth } from "$lib/reports/period-report";
  import {
    activePresets,
    arrowLabels,
    canStepNext,
    clampToToday,
    periodEyebrow,
    periodKind,
    periodLabel,
    presetPeriods,
    stepPeriod,
  } from "$lib/reports/period-state";

  interface Props {
    from: YearMonth;
    to: YearMonth;
    /** Tenant-local current month — the bar never moves past it. */
    today: YearMonth;
    /** A period request is in flight. */
    loading: boolean;
    /** Show "Exportieren" (`report:export`). */
    canExport: boolean;
    onChange: (from: YearMonth, to: YearMonth) => void;
    /** "Zeitraum…" was pressed; the trigger is handed over so focus can return to it. */
    onOpenRange: (trigger: HTMLElement) => void;
    /** "Exportieren" was pressed; the trigger is handed over so focus can return to it. */
    onOpenExport: (trigger: HTMLElement) => void;
    /**
     * Reports the bar's rendered height in px (border included): the sticky header of the person
     * table sits below the topbar AND this bar, so the page hands it down as `--period-bar-h`.
     */
    onHeight?: (px: number) => void;
  }

  let {
    from,
    to,
    today,
    loading,
    canExport,
    onChange,
    onOpenRange,
    onOpenExport,
    onHeight,
  }: Props = $props();

  let barEl: HTMLDivElement | undefined = $state();

  // Hands the rendered height (border included) to the page. A guarded ResizeObserver instead of
  // `bind:clientHeight`: the binding needs the API unconditionally and jsdom has none.
  $effect(() => {
    const el = barEl;
    if (!el) return;
    onHeight?.(el.offsetHeight);
    if (typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(() => onHeight?.(el.offsetHeight));
    observer.observe(el);
    return () => observer.disconnect();
  });

  const kind = $derived(periodKind(from, to, today));
  const arrows = $derived(arrowLabels(kind));
  const label = $derived(periodLabel(from, to, today));
  const eyebrow = $derived(periodEyebrow(from, to, today));
  const nextDisabled = $derived(!canStepNext(from, to, today));
  const presets = $derived(presetPeriods(today));
  const pressed = $derived(activePresets(from, to, today));
  // Display only: MonthBar derives its picker cursor from a Date (local time, first of month).
  const cursor = $derived(new Date(from.year, from.month - 1, 1));

  function step(dir: 1 | -1) {
    const next = stepPeriod(from, to, dir, today);
    if (next) onChange(next.from, next.to);
  }

  // P-16: a month chosen in the future is clamped to the current month.
  function selectMonth(month: number, year: number) {
    const picked = clampToToday({ year, month }, today);
    onChange(picked, { ...picked });
  }
</script>

<div class="period-sticky card-animate" data-testid="reports-period-bar" bind:this={barEl}>
  <MonthBar
    testIdPrefix="reports-period"
    date={cursor}
    {label}
    {eyebrow}
    prevLabel={arrows.prev}
    nextLabel={arrows.next}
    {nextDisabled}
    onPrev={() => step(-1)}
    onNext={() => step(1)}
    onSelectMonth={selectMonth}
    extraActions={narrowActions}
  />

  <div class="period-presets" class:period-presets--idle={!loading}>
    <div class="period-preset-group" role="group" aria-label="Schnellauswahl Zeitraum">
      {#each presets as preset (preset.key)}
        <button
          type="button"
          class="btn btn-ghost sm"
          class:is-active={pressed.includes(preset.key)}
          aria-pressed={pressed.includes(preset.key)}
          onclick={() => onChange(preset.from, preset.to)}>{preset.label}</button
        >
      {/each}
    </div>
    <button
      type="button"
      class="btn btn-outline sm period-range-wide"
      onclick={(e) => onOpenRange(e.currentTarget)}>Zeitraum…</button
    >
    {#if loading}
      <span class="period-loading"><Spinner label="Wird geladen" /></span>
    {/if}
  </div>
</div>

{#snippet narrowActions()}
  <button
    type="button"
    class="btn btn-outline sm period-range-narrow"
    onclick={(e) => onOpenRange(e.currentTarget)}>Zeitraum…</button
  >
  {#if canExport}
    <button
      type="button"
      class="btn btn-outline sm"
      data-testid="reports-period-export"
      onclick={(e) => onOpenExport(e.currentTarget)}
    >
      <Icon name="download" size={14} />
      Exportieren
    </button>
  {/if}
{/snippet}

<style>
  /* The bar is NOT a `.card`: under data-skin="modern" `.card` forces overflow:hidden, which would
     clip MonthBar's month picker. The sticky wrapper is the surface itself (the `.cal-monthbar`
     escape recipe). The card colours are repeated here on purpose and only here: `.card` cannot
     be used for a surface that must show an overflowing dropdown, and the layered gradient keeps
     the surface opaque in every skin and mode so scrolled content never shows through. */
  .period-sticky {
    position: sticky;
    top: var(--topbar-h);
    z-index: 30;
    overflow: visible;
    background: linear-gradient(var(--bg-card), var(--bg-card)), var(--bg);
    border: 1px solid var(--border);
    border-radius: var(--r-lg);
    box-shadow: var(--shadow-md);
  }

  .period-presets {
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    gap: var(--s-2);
    padding: var(--s-3) var(--s-6);
    border-top: 1px solid var(--border);
  }

  .period-preset-group {
    display: flex;
    flex-wrap: wrap;
    gap: var(--s-2);
  }

  /* Pressed preset: the accent is reserved for exactly this (text stays --text for contrast). */
  .period-presets .btn.is-active {
    background: var(--brand-soft);
    border-color: var(--brand-light);
    color: var(--text);
    font-weight: 600;
  }

  .period-loading {
    margin-left: auto;
    display: inline-flex;
    align-items: center;
    gap: var(--s-2);
    color: var(--text-muted);
    font-size: 12px;
  }

  /* "Zeitraum…" lives in the presets row on wide screens and next to the arrows on narrow ones. */
  .period-range-narrow {
    display: none;
  }

  @media (max-width: 960px) {
    /* Row 2 is not rendered (the presets live in the range dialog); only a loading cue stays. */
    .period-preset-group,
    .period-range-wide {
      display: none;
    }

    .period-presets--idle {
      display: none;
    }

    .period-presets {
      padding-top: var(--s-2);
      padding-bottom: var(--s-2);
    }

    .period-range-narrow {
      display: inline-flex;
    }
  }

  /* A two-row sticky bar would cover about 16 % of a phone: static there. */
  @media (max-width: 640px) {
    .period-sticky {
      position: relative;
      top: auto;
    }

    .period-range-narrow,
    .period-sticky :global(.month-bar-extra .btn) {
      min-height: 44px;
      flex: 1 1 0;
      justify-content: center;
    }
  }

  @media (pointer: coarse) {
    .period-presets .btn {
      min-height: 44px;
    }
  }
</style>

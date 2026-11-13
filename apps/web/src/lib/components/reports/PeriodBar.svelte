<script lang="ts">
  // Issue #612 (D-612-1, D-612-6) rebuilt on the Periodenwahl block for Issue #854: the ONE period
  // control of /reports is a PeriodPicker - arrows by the period's kind, a Monat / Quartal / Jahr
  // zoom, and the label as the entry to the range dialog (presets and „Von“ / „Bis“, opened from
  // the label). It owns no URL and no navigation: the page passes `onChange`. The export action
  // lives in the page head, not here.
  import PeriodPicker, { type PeriodZoom } from "$components/ui/PeriodPicker.svelte";
  import Skeleton from "$components/ui/Skeleton.svelte";
  import type { YearMonth } from "$lib/reports/period-report";
  import {
    arrowLabels,
    canStepNext,
    periodEyebrow,
    periodForZoom,
    periodKind,
    periodLabel,
    stepPeriod,
    zoomOfKind,
    type ReportZoom,
  } from "$lib/reports/period-state";

  interface Props {
    from: YearMonth;
    to: YearMonth;
    /** Tenant-local current month — the bar never moves past it. */
    today: YearMonth;
    /** A period request is in flight. */
    loading: boolean;
    onChange: (from: YearMonth, to: YearMonth) => void;
    /** The label was pressed; the trigger is handed over so focus can return to it. */
    onOpenRange: (trigger: HTMLElement) => void;
    /**
     * Reports the bar's rendered height in px (border included): the sticky header of the person
     * table sits below the topbar AND this bar, so the page hands it down as `--period-bar-h`.
     */
    onHeight?: (px: number) => void;
  }

  let { from, to, today, loading, onChange, onOpenRange, onHeight }: Props = $props();

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
  // A free range sits on no zoom level: the Segment then shows none selected.
  const zoom = $derived((zoomOfKind(kind) ?? "") as PeriodZoom);
  const ZOOMS: PeriodZoom[] = ["monat", "quartal", "jahr"];

  function step(dir: 1 | -1) {
    const next = stepPeriod(from, to, dir, today);
    if (next) onChange(next.from, next.to);
  }

  // The zoom keeps the end of the period as its anchor (P-16: never past the current month).
  function selectZoom(next: PeriodZoom) {
    const period = periodForZoom(next as ReportZoom, to, today);
    onChange(period.from, period.to);
  }

  function openRange() {
    const trigger = barEl?.querySelector<HTMLElement>('[data-testid="reports-period-label"]');
    if (trigger) onOpenRange(trigger);
  }
</script>

<div class="period-sticky card-animate" data-testid="reports-period-bar" bind:this={barEl}>
  <PeriodPicker
    testIdPrefix="reports-period"
    {label}
    {eyebrow}
    prevLabel={arrows.prev}
    nextLabel={arrows.next}
    {nextDisabled}
    onPrev={() => step(-1)}
    onNext={() => step(1)}
    zooms={ZOOMS}
    {zoom}
    onZoom={selectZoom}
    onLabelClick={openRange}
    labelTitle="Zeitraum wählen"
    extra={loadingCue}
  />
</div>

{#snippet loadingCue()}
  {#if loading}
    <span class="period-loading"><Skeleton inline width={8} /></span>
  {/if}
{/snippet}

<style>
  /* The bar is NOT a `.card`: a card surface may clip its content. The sticky wrapper is the
     surface itself. The card colours are repeated here on purpose and only here: the layered
     gradient keeps the surface opaque in every theme and mode so scrolled content never shows
     through. */
  .period-sticky {
    position: sticky;
    top: var(--topbar-h);
    z-index: 30;
    overflow: visible;
    background: linear-gradient(var(--card), var(--card)), var(--bg);
    border: 1px solid var(--line);
    border-radius: var(--r-card);
    box-shadow: var(--shadow);
  }

  .period-loading {
    display: inline-flex;
    align-items: center;
    gap: var(--s-2);
    color: var(--text-2);
    font-size: var(--fs-xs);
  }

  /* A two-row sticky bar would cover about 16 % of a phone: static there. */
  @media (max-width: 640px) {
    .period-sticky {
      position: relative;
      top: auto;
    }
  }
</style>

<script lang="ts">
  // Issue #588 (AC-588-1, AC-588-2, AC-588-3, D-588-1, D-588-5, D-588-7, P-07, P-11, P-12): the card
  // "Salden" at the top of the dashboard's team area. Diverging bars (largest plus above the zero
  // line, most negative below it), the same persons as a linked text list, the team median and the
  // persons who do not count. Every figure comes from `teamSaldoFigures` (the one module); the card
  // computes nothing, requests nothing and receives its rows from the page.
  import { Chart, BarController, BarElement, CategoryScale, LinearScale, Tooltip } from "chart.js";
  import Card from "$components/ui/Card.svelte";
  import CardHeader from "$components/ui/CardHeader.svelte";
  import { chartAriaLabel, getChartTheme } from "$lib/utils/chart-theme";
  import { TEAM_SALDO_BARS_CHART, teamSaldoBarsChartConfig } from "$lib/dashboard/team-charts";
  import { fmtBalance } from "$lib/utils/format-minutes";
  import { teamSaldoFigures, type TeamSaldoRow } from "$lib/reports/team-saldo";
  import { PERSON_SALDO_NOT_SPLIT_LABEL, SALON_HOME_PERSONS_NOTE } from "$lib/salons/page-scope";

  Chart.register(BarController, BarElement, CategoryScale, LinearScale, Tooltip);

  interface Props {
    /** The active (not exited) rows of GET /dashboard/overtime-overview. */
    rows: TeamSaldoRow[];
    loading?: boolean;
    /** True when the loaded answer was narrowed to one salon by Stammsalon (D-588-3). */
    salonFiltered?: boolean;
    /** The link target of a person, or null when the caller may not open it (P-11). */
    personHref: (id: string) => string | null;
    /** Opens a bar's target; only called with a non-null href. */
    onOpenPerson: (href: string) => void;
    /** Stagger index of the card entrance (the dashboard numbers its cards). */
    cardIdx?: number;
  }

  let {
    rows,
    loading = false,
    salonFiltered = false,
    personHref,
    onOpenPerson,
    cardIdx = 7,
  }: Props = $props();

  const EXCLUDED_SHOWN = 5;
  // One bar is 22 px; the axis, its title and the padding take 56 px (ten bars: 276 px).
  const BAR_PX = 22;
  const AXIS_PX = 56;

  const figures = $derived(teamSaldoFigures(rows));
  const excludedShown = $derived(figures.excluded.slice(0, EXCLUDED_SHOWN));
  const excludedMore = $derived(Math.max(0, figures.excluded.length - EXCLUDED_SHOWN));
  const hasAnyone = $derived(figures.counted + figures.excluded.length > 0);
  const chartHeight = $derived(figures.diverging.length * BAR_PX + AXIS_PX);

  let canvasEl = $state<HTMLCanvasElement | null>(null);

  $effect(() => {
    const el = canvasEl;
    const bars = figures.diverging;
    if (el === null || bars.length === 0) return;
    // The link of a bar is read at click time, so a changed `personHref` never rebuilds the chart.
    const hrefOfIndex = (index: number): string | null => {
      const bar = bars[index];
      return bar === undefined ? null : personHref(bar.id);
    };
    // Issue #591: the config comes from the one chart builder; the card only supplies the click.
    const chart = new Chart(
      el,
      teamSaldoBarsChartConfig(bars, getChartTheme(), {
        onBar: (index) => {
          const href = hrefOfIndex(index);
          if (href !== null) onOpenPerson(href);
        },
        isClickable: (index) => hrefOfIndex(index) !== null,
      }),
    );
    return () => chart.destroy();
  });
</script>

<Card animate class="team-saldo-card" style={`--card-idx: ${cardIdx};`}>
  <CardHeader title="Salden" />
  {#if loading}
    <div class="saldo-skeleton" aria-hidden="true"></div>
  {:else if !hasAnyone}
    <p class="saldo-empty">Keine Salden in Ihrer Reichweite</p>
  {:else}
    <div data-testid="team-saldo-values">
      <p class="saldo-median" data-testid="team-saldo-median">
        Team-Median:
        <strong>{figures.medianMinutes === null ? "—" : fmtBalance(figures.medianMinutes)}</strong>
        {#if figures.counted > 0}
          · {figures.counted}
          {figures.counted === 1 ? "Person" : "Personen"}
        {/if}
      </p>

      {#if figures.diverging.length > 0}
        <div class="saldo-body">
          <div class="saldo-chart" style={`height: ${chartHeight}px;`}>
            <canvas
              bind:this={canvasEl}
              role="img"
              aria-label={chartAriaLabel(TEAM_SALDO_BARS_CHART)}
            ></canvas>
          </div>
          <ol class="saldo-list" aria-label="Höchste Plus- und Minus-Salden im Team">
            {#each figures.diverging as bar (bar.id)}
              {@const href = personHref(bar.id)}
              <li class="saldo-item">
                {#if href !== null}
                  <a class="saldo-name" {href}>{bar.name}</a>
                {:else}
                  <span class="saldo-name">{bar.name}</span>
                {/if}
                <span
                  class="saldo-value"
                  class:pos={bar.totalMinutes > 0}
                  class:neg={bar.totalMinutes < 0}
                >
                  {bar.label}
                </span>
              </li>
            {/each}
          </ol>
        </div>
      {:else}
        <p class="saldo-empty">Keine Plus- oder Minus-Salden im Team</p>
      {/if}

      {#if figures.excluded.length > 0}
        <div class="saldo-excluded" data-testid="team-saldo-excluded">
          <p class="saldo-excluded-title">Nicht in der Kennzahl</p>
          <ul>
            {#each excludedShown as person (person.id)}
              <li>{person.name} <span class="saldo-reason">· {person.reasonLabel}</span></li>
            {/each}
          </ul>
          {#if excludedMore > 0}
            <p class="saldo-more">und {excludedMore} weitere</p>
          {/if}
        </div>
      {/if}
    </div>
  {/if}
  {#if salonFiltered}
    <p class="form-hint saldo-note">{SALON_HOME_PERSONS_NOTE} · {PERSON_SALDO_NOT_SPLIT_LABEL}</p>
  {/if}
</Card>

<style>
  .saldo-median {
    margin: 0 0 0.75rem;
    font-size: 0.875rem;
    color: var(--text-muted);
  }

  .saldo-median strong {
    color: var(--text);
    font-variant-numeric: tabular-nums;
  }

  .saldo-body {
    display: grid;
    grid-template-columns: minmax(0, 1.2fr) minmax(0, 1fr);
    gap: 1.5rem;
    align-items: start;
  }

  .saldo-chart {
    position: relative;
    min-width: 0;
  }

  .saldo-list {
    list-style: none;
    margin: 0;
    padding: 0;
    display: flex;
    flex-direction: column;
    min-width: 0;
  }

  .saldo-item {
    display: flex;
    justify-content: space-between;
    gap: 0.75rem;
    padding: 0.25rem 0;
    font-size: 0.875rem;
    border-bottom: 1px solid var(--border);
  }

  .saldo-item:last-child {
    border-bottom: none;
  }

  .saldo-name {
    min-width: 0;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    color: var(--text);
  }

  a.saldo-name {
    text-decoration: underline;
    text-underline-offset: 2px;
  }

  .saldo-value {
    font-variant-numeric: tabular-nums;
    font-weight: 600;
    white-space: nowrap;
  }

  .saldo-value.pos {
    color: var(--good-text);
  }

  .saldo-value.neg {
    color: var(--bad-text);
  }

  .saldo-empty {
    margin: 0.25rem 0 0.5rem;
    font-size: 0.875rem;
    color: var(--text-muted);
  }

  .saldo-excluded {
    margin-top: 1rem;
    font-size: 0.8125rem;
    color: var(--text-muted);
  }

  .saldo-excluded-title {
    margin: 0 0 0.25rem;
    font-weight: 600;
  }

  .saldo-excluded ul {
    margin: 0;
    padding-left: 1.1rem;
  }

  .saldo-more {
    margin: 0.25rem 0 0;
  }

  .saldo-note {
    margin: 0.75rem 0 0;
  }

  .saldo-skeleton {
    width: 100%;
    height: 200px;
    border-radius: var(--r-sm);
    background: linear-gradient(
      90deg,
      var(--bg-subtle) 25%,
      var(--bg-alt) 50%,
      var(--bg-subtle) 75%
    );
    background-size: 200% 100%;
    animation: saldo-shimmer 1.4s ease-in-out infinite;
  }

  @keyframes saldo-shimmer {
    0% {
      background-position: 200% 0;
    }
    100% {
      background-position: -200% 0;
    }
  }

  @media (max-width: 900px) {
    .saldo-body {
      grid-template-columns: minmax(0, 1fr);
    }
  }
</style>

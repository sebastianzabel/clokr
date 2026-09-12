<script lang="ts">
  // Quick task 260820-elk — Left-hand metrics card for /time-entries (design variant 1c
  // "Fortschritt"). Owns the month navigation slot (see D-NAV in 260820-elk-PLAN.md — the
  // MonthBar primitive renders INSIDE this card's nav row, without a `stats` prop, so it
  // stays the page's one and only month navigation), the big month-saldo figure, the
  // SollIstBar progress bar that explains it, and a purely informative status line.
  //
  // Lives in `saldo/` alongside the other saldo cards (KontoSaldoCard, SaldoAnzeige),
  // following the precedent this quick task itself established ("no second saldo-variant
  // tree in `ui/`" — SALDO-DISP-05). NOTE: unlike
  // `lib/components/ui/`, `lib/components/saldo/` is NOT scanned by `lint:ui-classes` — class
  // hygiene in this file is maintained by review, not by a gate.
  //
  // Employees CANNOT close a month (CONTEXT — LOCKED). The status line is purely
  // informative: icon + explanation + "Abschluss durch die Betriebsleitung" when
  // `canCloseMonth` is false (the default). No button, no link, no click handler.
  import type { Snippet } from "svelte";
  import Card from "$components/ui/Card.svelte";
  import SollIstBar from "$components/ui/SollIstBar.svelte";
  import { fmtMin, fmtBalance } from "$lib/utils/format-minutes";

  interface Props {
    /** The month navigation row — the page passes <MonthBar> here (see D-NAV). */
    monthNav?: Snippet;
    sollToDateMin: number;
    istMin: number;
    /** null = no WorkSchedule / no Soll target — figure collapses to "—". */
    saldoMin: number | null;
    /** "Soll (bisher)" or "Soll" — mirrors the label the month bar used to show. */
    sollLabel: string;
    /** Days in the displayed month, up to and including today, with worked minutes > 0.
     *  `null` = the caller has no such number for this month and the card must claim none
     *  (Phase 125 / issue #125: the count used to be recomputed client-side and could contradict
     *  `istMin`; it is now sourced from wherever `istMin` came from, and that source does not
     *  always have it — a CLOSED month's SaldoSnapshot stores no day count). */
    workdaysSoFar: number | null;
    /** Currently running (open-ended) entries. */
    runningCount: number;
    isLocked: boolean;
    canCloseMonth?: boolean;
    /** Optional extra context line (FLEXTIME week saldo, see D-WOCHE). */
    extraNote?: string;
    loading?: boolean;
    error?: boolean;
    onRetry?: () => void;
  }

  let {
    monthNav,
    sollToDateMin,
    istMin,
    saldoMin,
    sollLabel,
    workdaysSoFar,
    runningCount,
    isLocked,
    canCloseMonth = false,
    extraNote,
    loading = false,
    error = false,
    onRetry,
  }: Props = $props();

  const microLabel = $derived(isLocked ? "Monat-Saldo (Bestätigt)" : "Monat-Saldo (Prognose)");

  const sign = $derived.by(() => {
    if (saldoMin === null) return "neutral";
    if (saldoMin > 0) return "good";
    if (saldoMin < 0) return "bad";
    return "neutral";
  });

  const figureText = $derived(saldoMin === null ? "—" : fmtBalance(saldoMin));
</script>

<Card class="msc-card">
  <div data-testid="monat-saldo-card">
    {#if monthNav}
      <div class="msc-nav">
        {@render monthNav()}
      </div>
    {/if}

    {#if loading}
      <div class="msc-body">
        <div class="skeleton msc-skel-label"></div>
        <div class="skeleton msc-skel-figure"></div>
        <div class="skeleton msc-skel-bar"></div>
        <div class="skeleton msc-skel-labels"></div>
        <div class="msc-status">
          <div class="skeleton msc-skel-status"></div>
        </div>
      </div>
    {:else if error}
      <div class="msc-body msc-error-body">
        <p class="msc-error-text">Werte konnten nicht geladen werden.</p>
        <button type="button" class="btn btn-ghost btn-sm" onclick={onRetry}>Erneut laden</button>
      </div>
    {:else}
      <div class="msc-body">
        <div class="msc-microlabel">{microLabel}</div>
        <div class="msc-figure-row">
          <div class="msc-figure msc-figure--{sign}" data-testid="monat-saldo-figure">
            {figureText}
          </div>
          <div class="msc-context">
            {#if sollToDateMin > 0}
              <div class="msc-context-line">
                {sollLabel}
                {fmtMin(sollToDateMin)} h · Ist {fmtMin(istMin)} h erfüllt
              </div>
            {/if}
            {#if workdaysSoFar !== null}
              <div class="msc-context-line" data-testid="monat-saldo-workdays">
                {workdaysSoFar} Arbeitstage bisher{#if runningCount > 0}
                  &nbsp;· {runningCount} läuft{/if}
              </div>
            {:else if runningCount > 0}
              <div class="msc-context-line" data-testid="monat-saldo-running">
                {runningCount} läuft
              </div>
            {/if}
            {#if extraNote}
              <div class="msc-context-line">{extraNote}</div>
            {/if}
          </div>
        </div>

        <SollIstBar {sollToDateMin} {istMin} />

        <div class="msc-status">
          <div class="msc-status-left">
            <svg
              width="14"
              height="14"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              stroke-width="2"
              aria-hidden="true"
            >
              <rect x="3" y="11" width="18" height="11" rx="2" ry="2"></rect>
              <path d="M7 11V7a5 5 0 0 1 10 0v4"></path>
            </svg>
            <span
              >{isLocked
                ? "Monat ist abgeschlossen — Werte sind final."
                : "Noch kein Monatsabschluss — Werte sind vorläufig."}</span
            >
          </div>
          {#if !isLocked && !canCloseMonth}
            <span class="msc-status-right">Abschluss durch die Betriebsleitung</span>
          {/if}
        </div>
      </div>
    {/if}
  </div>
</Card>

<style>
  :global(.msc-card) {
    overflow: visible;
    position: relative;
    min-height: 220px;
  }

  .msc-nav {
    margin: 0 0 var(--s-2);
  }

  .msc-body {
    display: flex;
    flex-direction: column;
  }

  .msc-error-body {
    align-items: flex-start;
    gap: var(--s-3);
  }

  .msc-error-text {
    color: var(--text-muted);
    font-size: 14px;
    margin: 0;
  }

  .msc-microlabel {
    font-size: 10.5px;
    font-weight: 600;
    letter-spacing: 0.12em;
    text-transform: uppercase;
    color: var(--text-faint);
  }

  .msc-figure-row {
    display: flex;
    align-items: baseline;
    gap: var(--s-4);
    margin: var(--s-1) 0 var(--s-4);
    flex-wrap: wrap;
  }

  .msc-figure {
    font-family: var(--font-serif);
    font-size: 38px;
    font-variant-numeric: tabular-nums;
    line-height: 1;
  }

  .msc-figure--good {
    color: var(--good);
  }
  .msc-figure--bad {
    color: var(--bad);
  }
  .msc-figure--neutral {
    color: var(--text);
  }

  .msc-context {
    display: flex;
    flex-direction: column;
    gap: 2px;
    color: var(--text-muted);
    font-size: 13px;
  }

  .msc-context-line {
    line-height: 1.4;
  }

  .msc-status {
    display: flex;
    justify-content: space-between;
    align-items: center;
    gap: var(--s-3);
    font-size: 12px;
    color: var(--text-muted);
    border-top: 1px solid var(--border);
    margin-top: var(--s-4);
    padding-top: var(--s-3);
    flex-wrap: wrap;
  }

  .msc-status-left {
    display: flex;
    align-items: center;
    gap: var(--s-2);
  }

  .msc-status-right {
    color: var(--text-faint);
  }

  /* Loading skeletons — sized at the FINAL heights so nothing jumps between
     loading → loaded → error (the "cards must not jump" requirement). */
  .msc-skel-label {
    width: 140px;
    height: 11px;
  }
  .msc-skel-figure {
    width: 160px;
    height: 38px;
    margin: var(--s-1) 0 var(--s-4);
  }
  .msc-skel-bar {
    width: 100%;
    height: 12px;
  }
  .msc-skel-labels {
    width: 100%;
    height: 14px;
    margin-top: var(--s-2);
  }
  .msc-skel-status {
    width: 240px;
    height: 20px;
    margin-top: var(--s-4);
  }
</style>

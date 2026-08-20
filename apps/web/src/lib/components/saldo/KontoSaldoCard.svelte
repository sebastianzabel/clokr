<script lang="ts">
  // Quick task 260820-elk — quiet right-hand "Konto" card for /time-entries (design variant
  // 1c "Fortschritt"). Carries the lifetime overtime balance that used to sit next to the H1
  // (GesamtSaldoHeader — quick 260820-cy5), now relocated here per CONTEXT.
  //
  // ROUTE TAKEN (see the plan's "one_correction_to_the_plan" — this deliberately deviates
  // from the original 2b draft, which wrapped `<SaldoAnzeige variant="expanded">`):
  // `variant="expanded"` ALWAYS renders three rows when `confirmedMinutes` is split-mode
  // (confirmed, forecast, and — whenever `openMonthMinutes` is also supplied — a combined
  // "Voraussichtlich gesamt" row, since `combinedMinutes` is derived purely from those two
  // props with no way to suppress it via a prop). Reaching for `combinedLabel` to rename that
  // third row does not remove it; the card would show the open-month figure TWICE within one
  // card. That is the exact defect this task exists to fix (see GesamtSaldoHeader.svelte's own
  // header comment, and commit 94ded43d, for the identical failure mode already hit once on
  // this page today). Hiding the row with `:global()` was explicitly ruled out (suppresses
  // information to fake a mock). `variant="compact"` avoids the extra row but never shows a
  // VISIBLE label for the forecast figure (only an sr-only prefix) — the exact "unnamed
  // (−8:00)" defect CONTEXT names as the reason this task exists.
  //
  // So: this card renders its two figures itself, from the raw minutes already on the page,
  // using CONTEXT's locked vocabulary ("Gesamt-Saldo" / "Bestätigt" · "inkl. laufendem
  // Monat"). `SaldoAnzeige.svelte` is NOT imported and NOT modified — no new props, no
  // `:global()` overrides, no row-hiding CSS.
  import Card from "$components/ui/Card.svelte";
  import { fmtSigned } from "$lib/utils/format-minutes";

  interface Props {
    totalHours: number | null;
    confirmedMinutes?: number;
    openMonthMinutes?: number | null;
    hasClosedMonth?: boolean;
    rosterIncomplete?: boolean;
    loading?: boolean;
  }

  let {
    totalHours,
    confirmedMinutes = undefined,
    openMonthMinutes = undefined,
    hasClosedMonth = false,
    rosterIncomplete = false,
    loading = false,
  }: Props = $props();

  const isSplit = $derived(confirmedMinutes !== undefined);

  // The confirmed (or, in legacy fallback, the plain lifetime) figure, in minutes.
  const figureMin = $derived(
    isSplit ? (confirmedMinutes ?? 0) : totalHours !== null ? Math.round(totalHours * 60) : null,
  );
  const figureText = $derived(figureMin === null ? "—" : fmtSigned(figureMin));

  // Faint tone for a brand-new hire whose first month hasn't closed yet (mirrors
  // SaldoAnzeige's own isNewHireZero convention) — the number is real but not yet meaningful.
  const isNewHireZero = $derived(isSplit && figureMin === 0 && !hasClosedMonth);
  const tone = $derived.by(() => {
    if (figureMin === null) return "neutral";
    if (isNewHireZero) return "faint";
    if (figureMin > 0) return "good";
    if (figureMin < 0) return "bad";
    return "neutral";
  });

  const openMonthAvailable = $derived(openMonthMinutes !== undefined && openMonthMinutes !== null);
  const openMonthText = $derived(openMonthAvailable ? fmtSigned(openMonthMinutes ?? 0) : "—");
</script>

<Card class="ksc-card" style="background: var(--bg-subtle)">
  <div data-testid="konto-saldo-card">
    <div class="ksc-kicker">Konto</div>
    {#if loading}
      <div class="skeleton ksc-skel-label"></div>
      <div class="skeleton ksc-skel-figure"></div>
      {#if isSplit}
        <div class="ksc-divider"></div>
        <div class="skeleton ksc-skel-row"></div>
      {/if}
    {:else}
      <div class="ksc-label">Gesamt-Saldo</div>
      <div class="ksc-figure ksc-figure--{tone}">{figureText}</div>
      {#if isSplit}
        <div class="ksc-caption">
          {isNewHireZero ? "noch kein Monatsabschluss" : "Bestätigt"}
        </div>
        <div class="ksc-divider"></div>
        <div class="ksc-row">
          <span class="ksc-row-label"
            >inkl. laufendem Monat{#if rosterIncomplete}
              &nbsp;· Restmonat unverplant{/if}</span
          >
          <span class="ksc-row-value">{openMonthText}</span>
        </div>
      {/if}
    {/if}
  </div>
</Card>

<style>
  :global(.ksc-card) {
    min-height: 220px;
  }

  .ksc-kicker {
    font-size: 10.5px;
    font-weight: 600;
    letter-spacing: 0.12em;
    text-transform: uppercase;
    color: var(--text-faint);
    margin-bottom: var(--s-3);
  }

  .ksc-label {
    font-size: 12px;
    font-weight: 600;
    color: var(--text-muted);
  }

  .ksc-figure {
    font-family: var(--font-serif);
    font-size: 38px;
    font-variant-numeric: tabular-nums;
    line-height: 1;
    margin-top: var(--s-1);
  }

  .ksc-figure--good {
    color: var(--good);
  }
  .ksc-figure--bad {
    color: var(--bad);
  }
  .ksc-figure--neutral {
    color: var(--text);
  }
  .ksc-figure--faint {
    color: var(--text-faint);
  }

  .ksc-caption {
    font-size: 12px;
    color: var(--text-muted);
    margin-top: 2px;
  }

  .ksc-divider {
    border-top: 1px solid var(--border);
    margin: var(--s-4) 0 var(--s-3);
  }

  .ksc-row {
    display: flex;
    justify-content: space-between;
    align-items: baseline;
    gap: var(--s-2);
    font-size: 13px;
  }

  .ksc-row-label {
    color: var(--text-muted);
  }

  .ksc-row-value {
    font-variant-numeric: tabular-nums;
    font-weight: 600;
    color: var(--text);
  }

  .ksc-skel-label {
    width: 90px;
    height: 12px;
  }
  .ksc-skel-figure {
    width: 140px;
    height: 38px;
    margin-top: var(--s-1);
  }
  .ksc-skel-row {
    width: 100%;
    height: 16px;
  }
</style>

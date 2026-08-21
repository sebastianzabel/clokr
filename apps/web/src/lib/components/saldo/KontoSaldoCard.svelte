<script lang="ts">
  // Quick task 260820-elk — quiet right-hand "Konto" card for /time-entries (design variant
  // 1c "Fortschritt"). Carries the lifetime overtime balance that used to sit next to the H1
  // (added by quick 260820-cy5 as GesamtSaldoHeader, a component deleted by quick 260820-fkz
  // once this card replaced it on both /time-entries and /team/time-entries), now relocated
  // here per CONTEXT.
  //
  // ROUTE TAKEN (see the plan's "one_correction_to_the_plan" — this deliberately deviates
  // from the original 2b draft, which wrapped `<SaldoAnzeige variant="expanded">`):
  // `variant="expanded"` ALWAYS renders three rows when `confirmedMinutes` is split-mode
  // (confirmed, forecast, and — whenever `openMonthMinutes` is also supplied — a combined
  // "Voraussichtlich gesamt" row, since `combinedMinutes` is derived purely from those two
  // props with no way to suppress it via a prop). Reaching for `combinedLabel` to rename that
  // third row does not remove it; the card would show the open-month figure TWICE within one
  // card. That is the exact defect this task exists to fix (a failure mode already hit once
  // on this page today and reverted in commit 94ded43d). Hiding the row with `:global()` was
  // explicitly ruled out (suppresses
  // information to fake a mock). `variant="compact"` avoids the extra row but never shows a
  // VISIBLE label for the forecast figure (only an sr-only prefix) — the exact "unnamed
  // (−8:00)" defect CONTEXT names as the reason this task exists.
  //
  // So: this card renders its two figures itself, from the raw minutes already on the page,
  // using CONTEXT's locked vocabulary ("Gesamt-Saldo" / "Bestätigt" · "inkl. laufendem
  // Monat"). `SaldoAnzeige.svelte` is NOT imported and NOT modified — no new props, no
  // `:global()` overrides, no row-hiding CSS.
  import Card from "$components/ui/Card.svelte";
  import { fmtBalance, fmtMin } from "$lib/utils/format-minutes";

  interface Props {
    totalHours: number | null;
    confirmedMinutes?: number;
    openMonthMinutes?: number | null;
    hasClosedMonth?: boolean;
    rosterIncomplete?: boolean;
    loading?: boolean;
    // Phase 100 (OTC-03) — optional tolerance-exceeded badge. Both default to `undefined`
    // so every pre-Phase-100 call site (including team/time-entries, deliberately not
    // wired this phase — see 100-05-SUMMARY.md) renders byte-identically to before.
    isNegativeLimitExceeded?: boolean;
    maxNegativeBalanceMinutes?: number | null;
  }

  let {
    totalHours,
    confirmedMinutes = undefined,
    openMonthMinutes = undefined,
    hasClosedMonth = false,
    rosterIncomplete = false,
    loading = false,
    isNegativeLimitExceeded = undefined,
    maxNegativeBalanceMinutes = undefined,
  }: Props = $props();

  const isSplit = $derived(confirmedMinutes !== undefined);

  // The confirmed (or, in legacy fallback, the plain lifetime) figure, in minutes.
  const figureMin = $derived(
    isSplit ? (confirmedMinutes ?? 0) : totalHours !== null ? Math.round(totalHours * 60) : null,
  );
  // 260820-elk follow-up (coordinator-measured deviation #3) — this headline figure ALWAYS
  // carries a sign character per the design handoff README's Formatierung/Accessibility
  // rules ("Vorzeichen immer als Zeichen ausschreiben (− / + / ±), nicht nur farblich"), so
  // exact zero renders "±0:00" here — a DELIBERATELY different zero convention from
  // MonatSaldoCard's month figure (which stays locked to bare "0:00", see format-minutes.ts).
  const figureText = $derived(figureMin === null ? "—" : fmtBalance(figureMin));

  // Still used for the CAPTION distinction only ("noch kein Monatsabschluss" vs "Bestätigt")
  // — a brand-new hire whose first month hasn't closed yet gets a different caption, but (per
  // the coordinator's fix) NOT a different colour tone any more; --text-faint is reserved for
  // day numbers without values, not for a real, just-not-yet-meaningful saldo figure.
  const isNewHireZero = $derived(isSplit && figureMin === 0 && !hasClosedMonth);
  const tone = $derived.by(() => {
    if (figureMin === null) return "neutral";
    if (figureMin === 0) return "muted";
    if (figureMin > 0) return "good";
    return "bad";
  });

  const openMonthAvailable = $derived(openMonthMinutes !== undefined && openMonthMinutes !== null);
  const openMonthText = $derived(openMonthAvailable ? fmtBalance(openMonthMinutes ?? 0) : "—");
  // 260820-elk follow-up (coordinator-measured deviation #2) — the row VALUE must read as a
  // figure (size + sign colour), not as quiet as its own label.
  const openMonthTone = $derived.by(() => {
    if (!openMonthAvailable) return "muted";
    const v = openMonthMinutes ?? 0;
    if (v > 0) return "good";
    if (v < 0) return "bad";
    return "muted";
  });
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
      <!-- Phase 100 (OTC-03) — placement resolves a contradiction in the APPROVED
           UI-SPEC: it says "directly after .ksc-figure/.ksc-caption, before
           .ksc-divider" AND "outside the isSplit branch", but .ksc-caption/
           .ksc-divider are themselves inside that branch. Resolved in favour of the
           orthogonality requirement (the flag is independent of whether Phase-97
           split data loaded): this block sits directly under the figure, before the
           isSplit branch below. It therefore renders between the figure and the
           "Bestätigt" caption in split mode, and directly under the figure in
           legacy/non-split mode — pinned by the "legacy mode" test in
           KontoSaldoCard.test.ts. No null-guard on maxNegativeBalanceMinutes: the
           upstream formula (overtime.ts:173) can only set isNegativeLimitExceeded=
           true when maxNegMinutes != null — a defensive `?? 0` here would hide a
           contract break instead of surfacing it; the `!` below asserts that
           invariant instead of silently working around it. -->
      {#if isNegativeLimitExceeded}
        <div class="ksc-tolerance-warn">
          <span class="badge badge-yellow">Toleranzgrenze überschritten</span>
          <span class="ksc-tolerance-warn-hint"
            >erlaubt: {fmtMin(maxNegativeBalanceMinutes!)} Std. Minus</span
          >
        </div>
      {/if}
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
          <span class="ksc-row-value ksc-row-value--{openMonthTone}">{openMonthText}</span>
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
  .ksc-figure--muted {
    color: var(--text-muted);
  }

  /* Phase 100 (OTC-03) — tolerance-exceeded badge. Holds only the global
     .badge.badge-yellow pill and the caption span; no font declarations of its own. */
  .ksc-tolerance-warn {
    display: flex;
    align-items: center;
    gap: var(--s-2);
    margin-top: var(--s-2);
    flex-wrap: wrap;
  }

  /* UI-checker follow-up #1 — was previously unspecified; matches the established
     hint-text idiom (.balance-hint-muted, .form-hint). */
  .ksc-tolerance-warn-hint {
    font-size: 0.8125rem;
    color: var(--text-muted);
  }

  /* Phase 100 Plan 06 (Q1, owner checkpoint 2026-08-21) — dark-mode contrast fallback.
     Measured against the running app (data-mode="dark", theme pflaume): --warn (#b45309)
     text on the composited dark-mode --warn-soft background is 2.73:1 — fails WCAG AA
     (4.5:1 normal text, 3:1 even at large text). Root cause: --warn-soft IS overridden
     for dark mode (see [data-mode="dark"] in tokens.css) but --warn itself is NOT, so
     dark mode pairs a dark orange-brown with a near-black tinted background. Fallback
     mirrors SaldoAnzeige.svelte's .saldo__roster-badge treatment — color: var(--text) on
     the same --warn-soft background — measured at 11.64:1. Scoped to THIS badge only via
     the .ksc-tolerance-warn ancestor (established codebase idiom, see
     teamcal/+page.svelte's `:global([data-mode="dark"]) .row-avatar`); deliberately does
     NOT override the --warn token itself, which the owner rejected as too wide a blast
     radius (would repaint every --warn consumer app-wide). Light mode is unaffected —
     .badge-yellow's global color: var(--warn) (app.css) still applies there unchanged. */
  :global([data-mode="dark"]) .ksc-tolerance-warn .badge-yellow {
    color: var(--text);
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

  /* 260820-elk follow-up (coordinator-measured deviation #2) — was 13px/uncoloured (same
     size as its own label, so it didn't read as a figure at all). Now sized/coloured like
     an actual figure: 17px, sign-toned. */
  .ksc-row-value {
    font-variant-numeric: tabular-nums;
    font-weight: 600;
    font-size: 17px;
  }
  .ksc-row-value--good {
    color: var(--good);
  }
  .ksc-row-value--bad {
    color: var(--bad);
  }
  .ksc-row-value--muted {
    color: var(--text-muted);
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

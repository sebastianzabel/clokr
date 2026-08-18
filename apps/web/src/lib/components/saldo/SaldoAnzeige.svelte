<script lang="ts">
  // Phase 76-02 — Pure-presentational Überstundensaldo display.
  //
  // Standalone primitive covering the 5 Saldo states:
  //   - 0h (zero)
  //   - positive (e.g. +2:00)
  //   - negative (e.g. −1:30, U+2212 minus)
  //   - locked (Monatsabschluss-Badge co-occurrence)
  //   - no-schedule (saldoMinutes === null → "Kein Stundenplan")
  //
  // Phase 76.7 (D-16, UI-V19-04) — added `exempt` prop. When true, the
  // numeric saldo is replaced with an em-dash "—" (U+2014) so § 18 ArbZG
  // exempt employees (Inhaber/Geschäftsführer/leitende Angestellte) don't
  // see a misleading number. The sign-state collapses to "exempt" → no
  // green/red colour cue. BUrlG vacation tracking is unaffected by this
  // flag (see CONTEXT D-15..D-16).
  //
  // Like CalendarCell, this lives alongside (not replacing) the existing
  // form-context-bound "Überstundensaldo-Info" block in
  // routes/(app)/leave/+page.svelte. See 76-02-SUMMARY.md for context.
  //
  // Phase 97-01 (TRACER, SALDO-DISP-01/03/05) — additive split mode:
  // "Bestätigt" (confirmed carry-over from closed months) vs. "Laufender
  // Monat (Prognose)" (the open month, forecast). Presence of `confirmedMinutes`
  // (!== undefined) switches this component into split rendering; omitting it
  // renders EXACTLY what this component rendered before Phase 97 (byte-identical
  // legacy behaviour — the 13 pre-existing tests + the § 18 exempt behaviour stay
  // green). This is how SALDO-DISP-05 ("one presentation, not three") is
  // satisfied: extending this ONE shared primitive rather than growing a fourth
  // saldo variant elsewhere. See 97-UI-SPEC.md for the full state matrix/copy
  // contract — the tooltip / info-icon / "Restmonat unverplant" badge are a
  // later plan in this phase, not implemented here.

  export interface SaldoAnzeigeProps {
    saldoMinutes?: number | null;
    isLocked?: boolean;
    variant?: "compact" | "expanded";
    label?: string;
    /** Phase 76.7 (D-16) — § 18 ArbZG-exempt: render "—" instead of saldo number. */
    exempt?: boolean;
    /** Phase 97-01 — confirmed carry-over (closed months), in minutes. Presence of this
     *  prop (!== undefined) switches the component into split rendering. */
    confirmedMinutes?: number;
    /** Open-month forecast, in minutes. `null` = fail-safe/unavailable (renders "—",
     *  suppresses the combined line — a sum of an unknown is not actionable). */
    openMonthMinutes?: number | null;
    /** Whether a closed month exists yet — governs the confirmed=0 caption
     *  ("ausgeglichen" vs. "noch kein Monatsabschluss", UI-SPEC state A2 vs A3). */
    hasClosedMonth?: boolean;
    confirmedLabel?: string;
    forecastLabel?: string;
    combinedLabel?: string;
  }

  let {
    saldoMinutes = null,
    isLocked = false,
    variant = "expanded",
    label = "Saldo",
    exempt = false,
    confirmedMinutes = undefined,
    openMonthMinutes = undefined,
    hasClosedMonth = false,
    confirmedLabel = "Bestätigt",
    forecastLabel = "Laufender Monat (Prognose)",
    combinedLabel = "Voraussichtlich gesamt",
  }: SaldoAnzeigeProps = $props();

  const isSplit = $derived(confirmedMinutes !== undefined);

  // Root sign class: driven by confirmedMinutes in split mode (so --good/--bad stay reserved
  // for the entitlement figure), by saldoMinutes in legacy mode (unchanged behaviour).
  const sign = $derived.by(() => {
    if (exempt) return "exempt";
    if (confirmedMinutes !== undefined) {
      return confirmedMinutes === 0 ? "zero" : confirmedMinutes > 0 ? "positive" : "negative";
    }
    if (saldoMinutes === null) return "no-schedule";
    if (saldoMinutes === 0) return "zero";
    return saldoMinutes > 0 ? "positive" : "negative";
  });

  // Confirmed-figure visual tone (split mode only) — distinct from `sign` because UI-SPEC state
  // A3 (zero + no closed month yet) must render faint, not neutral, even though its sign is "zero".
  const confirmedTone = $derived.by(() => {
    if (confirmedMinutes === undefined) return "";
    if (confirmedMinutes === 0 && !hasClosedMonth) return "faint";
    if (confirmedMinutes > 0) return "good";
    if (confirmedMinutes < 0) return "bad";
    return "neutral";
  });

  // UI-SPEC states A1–A4 — the confirmed figure's caption. Never rendered on the forecast.
  const confirmedCaption = $derived.by(() => {
    if (confirmedMinutes === undefined) return "";
    if (confirmedMinutes > 0) return "Guthaben";
    if (confirmedMinutes < 0) return "offen";
    return hasClosedMonth ? "ausgeglichen" : "noch kein Monatsabschluss";
  });

  // A3 ("noch kein Monatsabschluss") is the one caption UI-SPEC keeps even in compact —
  // misreading 0:00 as a real entitlement is worse than the density cost.
  const isNewHireZero = $derived(confirmedMinutes === 0 && !hasClosedMonth);

  // The forecast is "unavailable" (Task 1's fail-safe shape) when null/undefined — render an
  // en-dash and suppress the combined line entirely.
  const forecastAvailable = $derived(openMonthMinutes !== undefined && openMonthMinutes !== null);

  // Voraussichtlich gesamt — pure display arithmetic over two numbers the API already
  // guarantees reconcile (confirmedMinutes + openMonthMinutes === total, by construction).
  const combinedMinutes = $derived.by(() => {
    if (confirmedMinutes === undefined) return null;
    if (openMonthMinutes === undefined || openMonthMinutes === null) return null;
    return confirmedMinutes + openMonthMinutes;
  });

  const classes = $derived.by(() => {
    const out = ["saldo", `saldo--${sign}`];
    if (isSplit) out.push("saldo--split");
    if (isLocked) out.push("saldo--locked");
    if (variant === "compact") out.push("saldo--compact");
    return out.join(" ");
  });

  function fmt(m: number): string {
    // U+2212 minus sign for negatives (matches CalendarCell delta + v1.5 type recipe).
    const prefix = m > 0 ? "+" : m < 0 ? "−" : "";
    const abs = Math.abs(m);
    const h = Math.floor(abs / 60);
    const min = abs % 60;
    return `${prefix}${h}:${String(min).padStart(2, "0")}`;
  }
</script>

<div class={classes} data-testid="saldo-anzeige">
  {#if variant === "expanded"}
    <div class="saldo__label" data-testid="saldo-label">{label}</div>
  {/if}

  {#if exempt}
    <!-- Phase 76.7 (D-16, UI-V19-04) — § 18 ArbZG exempt: em-dash, no number. -->
    <div class="saldo__value" data-testid="saldo-value">—</div>
  {:else if isSplit}
    {#if variant === "compact"}
      <!-- UI-SPEC compact: single line — confirmed leads, forecast follows inline in
           parentheses. Captions/combined line collapse away, EXCEPT the "noch kein
           Monatsabschluss" caption (state A3), which is kept even here. -->
      <div class="saldo__split saldo__split--compact">
        <span
          class="saldo__confirmed-value saldo__confirmed-value--{confirmedTone}"
          data-testid="saldo-confirmed-value"
        >
          {fmt(confirmedMinutes ?? 0)}
        </span>
        <span class="saldo__forecast-value" data-testid="saldo-forecast-value">
          ({forecastAvailable ? fmt(openMonthMinutes ?? 0) : "—"})
        </span>
        {#if isNewHireZero}
          <span
            class="saldo__confirmed-caption saldo__confirmed-caption--faint"
            data-testid="saldo-confirmed-caption"
          >
            · {confirmedCaption}
          </span>
        {/if}
      </div>
    {:else}
      <!-- UI-SPEC expanded: three-line stack — confirmed (hero), forecast, combined. -->
      <div class="saldo__split">
        <div class="saldo__confirmed">
          <div class="saldo__confirmed-label">{confirmedLabel}</div>
          <div
            class="saldo__confirmed-value saldo__confirmed-value--{confirmedTone}"
            data-testid="saldo-confirmed-value"
          >
            {fmt(confirmedMinutes ?? 0)}
          </div>
          <div
            class="saldo__confirmed-caption"
            class:saldo__confirmed-caption--faint={isNewHireZero}
            data-testid="saldo-confirmed-caption"
          >
            {confirmedCaption}
          </div>
        </div>

        <div class="saldo__forecast">
          <div class="saldo__forecast-label" data-testid="saldo-forecast-label">
            {forecastLabel}
          </div>
          <div class="saldo__forecast-value" data-testid="saldo-forecast-value">
            {forecastAvailable ? fmt(openMonthMinutes ?? 0) : "—"}
          </div>
        </div>

        {#if combinedMinutes !== null}
          <div class="saldo__combined">
            <span class="saldo__combined-label">{combinedLabel}</span>
            <span class="saldo__combined-value" data-testid="saldo-combined-value"
              >{fmt(combinedMinutes)}</span
            >
          </div>
        {/if}
      </div>
    {/if}
  {:else if saldoMinutes === null}
    <div class="saldo__value" data-testid="saldo-value">Kein Stundenplan</div>
  {:else}
    <div class="saldo__value" data-testid="saldo-value">{fmt(saldoMinutes)}</div>
  {/if}

  {#if isLocked}
    <span
      class="saldo__locked-badge"
      data-testid="saldo-locked-badge"
      aria-label="Monat abgeschlossen"
    >
      🔒
    </span>
  {/if}
</div>

<style>
  /* Internal element layout only — no token overrides per UI_STYLE_GUIDE.
     The .saldo + .saldo--* sign classes are emitted for global app.css to
     paint sign colors. Tests assert class + text content only; no visual
     regression is expected from missing global rules. */
  .saldo {
    display: inline-flex;
    align-items: baseline;
    gap: 0.5rem;
    font-variant-numeric: tabular-nums;
  }
  .saldo__label {
    font-size: 0.75rem;
    color: var(--text-muted);
  }
  .saldo__value {
    font-weight: 600;
    font-size: 1rem;
  }
  .saldo__locked-badge {
    opacity: 0.6;
  }
  .saldo--compact .saldo__value {
    font-size: 0.875rem;
  }

  /* ── Phase 97-01 — split rendering (expanded) ─────────────────────────────
     .saldo is display:inline-flex (align-items: baseline); the split root
     switches the whole component to a column stack. */
  .saldo--split {
    display: inline-flex;
    align-items: flex-start;
  }
  .saldo__split {
    display: flex;
    flex-direction: column;
    gap: var(--s-4);
  }

  .saldo__confirmed,
  .saldo__forecast {
    display: flex;
    flex-direction: column;
    gap: var(--s-1);
  }

  .saldo__confirmed-label,
  .saldo__forecast-label,
  .saldo__combined-label {
    font-size: 12px;
    font-weight: 600;
    color: var(--text-muted);
  }

  /* Display-size hero value (expanded confirmed only) — matches the .kpi-value convention. */
  .saldo__confirmed-value {
    font-family: var(--font-serif);
    font-size: 38px;
    font-weight: 400;
    line-height: 1;
    font-variant-numeric: tabular-nums;
  }
  .saldo__confirmed-value--good {
    color: var(--good);
  }
  .saldo__confirmed-value--bad {
    color: var(--bad);
  }
  .saldo__confirmed-value--neutral {
    color: var(--text);
  }
  .saldo__confirmed-value--faint {
    color: var(--text-faint);
  }

  .saldo__confirmed-caption {
    font-size: 12px;
    color: var(--text-muted);
  }
  .saldo__confirmed-caption--faint {
    color: var(--text-faint);
  }

  /* Forecast + combined values are ALWAYS muted, regardless of sign — a locked decision:
     colour must never imply certainty the forecast doesn't have (never --good/--bad/--warn). */
  .saldo__forecast-value {
    font-size: 16px;
    font-weight: 600;
    color: var(--text-muted);
    font-variant-numeric: tabular-nums;
  }

  .saldo__combined {
    display: flex;
    align-items: baseline;
    gap: var(--s-2);
  }
  .saldo__combined-value {
    font-size: 12px;
    font-weight: 600;
    color: var(--text-muted);
    font-variant-numeric: tabular-nums;
  }

  /* ── Phase 97-01 — split rendering (compact) ──────────────────────────────
     Single line: confirmed (Heading size) leads, forecast follows inline in
     parentheses (subordinate size). Captions/combined line collapse away. */
  .saldo__split--compact {
    display: inline-flex;
    align-items: baseline;
    gap: var(--s-1);
    flex-wrap: wrap;
  }
  .saldo__split--compact .saldo__confirmed-value {
    font-family: inherit;
    font-size: 16px;
    font-weight: 600;
    line-height: 1.2;
  }
  .saldo__split--compact .saldo__forecast-value {
    font-size: 12px;
    font-weight: 600;
  }
  .saldo__split--compact .saldo__confirmed-caption {
    font-size: 12px;
  }
</style>

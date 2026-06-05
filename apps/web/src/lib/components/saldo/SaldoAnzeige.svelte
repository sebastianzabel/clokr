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
  // Like CalendarCell, this lives alongside (not replacing) the existing
  // form-context-bound "Überstundensaldo-Info" block in
  // routes/(app)/leave/+page.svelte. See 76-02-SUMMARY.md for context.

  export interface SaldoAnzeigeProps {
    saldoMinutes: number | null;
    isLocked?: boolean;
    variant?: "compact" | "expanded";
    label?: string;
  }

  let {
    saldoMinutes,
    isLocked = false,
    variant = "expanded",
    label = "Saldo",
  }: SaldoAnzeigeProps = $props();

  const sign = $derived(
    saldoMinutes === null
      ? "no-schedule"
      : saldoMinutes === 0
        ? "zero"
        : saldoMinutes > 0
          ? "positive"
          : "negative",
  );

  const classes = $derived.by(() => {
    const out = ["saldo", `saldo--${sign}`];
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

  {#if saldoMinutes === null}
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
</style>

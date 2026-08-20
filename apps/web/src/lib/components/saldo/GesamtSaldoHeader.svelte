<script lang="ts">
  // Quick task 260820-cy5 (D-01) — the month-independent lifetime overtime balance
  // ("Gesamt-Saldo"), deliberately rendered OUTSIDE the month bar and placed next to
  // the page heading instead. Root cause this fixes: the month bar's `.mstat` tiles are
  // single-line (label above value), while this figure needs its own stacked block
  // (value, then a forecast line with an info toggletip) — cramming that into a
  // one-line tile row is what produced the "merkwürdige Anordnung" the owner flagged.
  //
  // Shared between /time-entries and /team/time-entries (SALDO-DISP-04 — a manager
  // must see the same presentation of the same numbers as the employee). Lives under
  // components/saldo/ rather than components/ui/ so no second Saldo-variant tree grows
  // there (SALDO-DISP-05 — "one presentation, not three").
  //
  // Pure presentation: consumes overtimeConfirmedMinutes / overtimeOpenMonthMinutes /
  // overtimeHasClosedMonth / overtimeRosterIncomplete / overtimeTotalHours exactly as
  // both pages already fetch them. No saldo is computed here, and no API call is made
  // from this component.
  import SaldoAnzeige from "$components/saldo/SaldoAnzeige.svelte";

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
</script>

<div class="gesamt-saldo-head" data-testid="gesamt-saldo-head">
  {#if confirmedMinutes !== undefined}
    <SaldoAnzeige
      variant="expanded"
      label="Gesamt-Saldo"
      {confirmedMinutes}
      openMonthMinutes={openMonthMinutes ?? null}
      hasClosedMonth={hasClosedMonth ?? false}
      {rosterIncomplete}
      {loading}
    />
  {:else}
    <SaldoAnzeige
      variant="expanded"
      label="Gesamt-Saldo"
      saldoMinutes={totalHours !== null ? Math.round(totalHours * 60) : null}
      {loading}
    />
  {/if}
</div>

<style>
  /* Layout/spacing only — no token overrides. Sits in PageHead's `actions` slot,
     which is `align-items: center`; the stacked SaldoAnzeige block wants to align
     with the H1's baseline instead, hence flex-end here (PageHead itself stays
     untouched). */
  .gesamt-saldo-head {
    display: flex;
    align-self: flex-end;
  }
</style>

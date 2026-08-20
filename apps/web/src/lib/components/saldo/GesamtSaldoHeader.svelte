<script lang="ts">
  // Quick task 260820-cy5 (D-01) — the month-independent lifetime overtime balance
  // ("Gesamt-Saldo"), deliberately rendered OUTSIDE the month bar and placed next to
  // the page heading instead.
  //
  // Variant history (kept here because the reasoning is worth keeping): the plan
  // originally specified `variant="expanded"`, following an ASCII preview that showed
  // the value stacked above a "Prognose ⓘ" line. A follow-up visual measurement on the
  // running stack found that `expanded` renders EIGHT text nodes including a
  // `saldo__combined-value` ("Voraussichtlich gesamt") — a THIRD on-screen copy of the
  // open-month figure (forecast-value + combined-value + the Monat-Saldo tile in the
  // month bar below), worsening the exact duplication the owner originally flagged.
  // Reverted to `variant="compact"` — the same variant `team/time-entries` already used
  // for this tile before this task, a proven Phase-97-compliant single-line rendering
  // (confirmed value, forecast in parentheses, info trigger — no combined line, no
  // 38px display figure) that brings the duplicate count back down to two (forecast +
  // month-bar tile), matching pre-task behaviour.
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
      variant="compact"
      label="Gesamt-Saldo"
      {confirmedMinutes}
      openMonthMinutes={openMonthMinutes ?? null}
      hasClosedMonth={hasClosedMonth ?? false}
      {rosterIncomplete}
      {loading}
    />
  {:else}
    <SaldoAnzeige
      variant="compact"
      label="Gesamt-Saldo"
      saldoMinutes={totalHours !== null ? Math.round(totalHours * 60) : null}
      {loading}
    />
  {/if}
</div>

<style>
  /* Layout/spacing only — no token overrides. Sits in PageHead's `actions` slot,
     which is `align-items: center`; the compact SaldoAnzeige row wants to align
     with the H1's baseline instead, hence flex-end here (PageHead itself stays
     untouched). */
  .gesamt-saldo-head {
    display: flex;
    align-self: flex-end;
  }
</style>

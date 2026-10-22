<script lang="ts">
  // Issue #612 (D-612-3, UI-SPEC "KPI card") - the eight figures of the period: two rows of four
  // KPIStat tiles. Pattern 3: every value is the server's own figure (minutes, days) formatted
  // here; nothing is added, derived or recomputed. A figure the caller may not see arrives as
  // `null` and renders as a dash with the reason as its delta line, so the grid never jumps.
  // Issue #714: under a salon filter the card shows the whole sums of the persons by Stammsalon at
  // the period end, with the owner's hint; the hours worked in the salon are a separate tile in
  // its own row with no saldo beside it, so they never meet Soll.
  import KPIStat from "$components/ui/KPIStat.svelte";
  import type { PeriodKpis } from "$lib/reports/period-report";
  import { fmtDateDe, fmtDaysDe, fmtHoursDe } from "$lib/reports/period-format";
  import {
    HOME_SALON_CHANGE_NOTE,
    PERSON_SALDO_BY_HOME_SALON_LABEL,
    SALON_WORKED_DELTA_NOTE,
    SALON_WORKED_LABEL,
    withoutHomeSalonNote,
  } from "$lib/salons/page-scope";

  interface Props {
    /** The `kpis` object of the period answer; null until the first answer. */
    kpis: PeriodKpis | null;
    /** A salon filter applies (persons by Stammsalon, whole values, #714). */
    filterActive: boolean;
    /** Persons of the reach without a Stammsalon in an active salon; null without a filter. */
    withoutHomeSalonCount?: number | null;
    /** A request is in flight; without `kpis` this renders the skeleton. */
    loading: boolean;
  }

  let { kpis, filterActive, withoutHomeSalonCount = null, loading }: Props = $props();

  const DASH = "—";
  // A salon filter withholds nothing (#714): the only reason a figure is missing is the permission.
  const WITHHELD_REASON = "Keine Berechtigung";

  const showSkeleton = $derived(kpis === null && loading);

  function hours(min: number | null, signed: boolean): string {
    return min === null ? DASH : fmtHoursDe(min, { signed });
  }

  const balanceDelta = $derived(
    kpis === null || kpis.balanceMinutes === null
      ? WITHHELD_REASON
      : kpis.allMonthsConfirmed
        ? "bestätigt"
        : "enthält Prognose",
  );
  const closingDelta = $derived(
    kpis === null || kpis.closingBalanceMinutes === null
      ? WITHHELD_REASON
      : `Stand ${fmtDateDe(kpis.closingAsOf)} · ${kpis.closingConfirmed ? "bestätigt" : "Prognose"}`,
  );
  const sollDelta = $derived(
    kpis === null || kpis.expectedMinutes === null ? WITHHELD_REASON : undefined,
  );

  const personsNote = $derived(
    kpis === null
      ? null
      : `Summe über ${kpis.personCount} ${kpis.personCount === 1 ? "Person" : "Personen"}`,
  );
  // Saldo is covered for fewer persons than listed: say so (and only then).
  const saldoNote = $derived(
    kpis !== null && kpis.saldoPersonCount > 0 && kpis.saldoPersonCount < kpis.personCount
      ? `Saldo: Summe über ${kpis.saldoPersonCount} von ${kpis.personCount} Personen`
      : null,
  );
  const forecastNote = $derived(kpis !== null && !kpis.allMonthsConfirmed);
  const salonWorkedMinutes = $derived(
    filterActive && kpis !== null && typeof kpis.salonWorkedMinutes === "number"
      ? kpis.salonWorkedMinutes
      : null,
  );
</script>

<div class="period-kpis" data-testid="period-kpis" aria-busy={loading}>
  {#if showSkeleton}
    <div class="kpi-grid" data-testid="period-kpis-skeleton">
      {#each Array.from({ length: 8 }, (_, i) => i) as i (i)}
        <div class="skeleton skeleton-text kpi-skeleton"></div>
      {/each}
    </div>
    <span class="sr-only">Bericht wird geladen…</span>
  {:else if kpis}
    <div class="kpi-grid kpi-grid--first">
      <KPIStat
        label="Saldo im Zeitraum"
        value={hours(kpis.balanceMinutes, true)}
        unit={kpis.balanceMinutes === null ? undefined : "h"}
        delta={balanceDelta}
        deltaTone="neutral"
      />
      <KPIStat
        label="Gesamtsaldo am Ende"
        value={hours(kpis.closingBalanceMinutes, true)}
        unit={kpis.closingBalanceMinutes === null ? undefined : "h"}
        delta={closingDelta}
        deltaTone="neutral"
      />
      <KPIStat label="Ist" value={fmtHoursDe(kpis.workedMinutes)} unit="h" />
      <KPIStat
        label="Soll"
        value={hours(kpis.expectedMinutes, false)}
        unit={kpis.expectedMinutes === null ? undefined : "h"}
        delta={sollDelta}
        deltaTone="neutral"
      />
    </div>

    <p class="period-kpi-note" data-testid="period-kpis-persons">
      {personsNote}{#if saldoNote}<br />{saldoNote}{/if}
    </p>

    <hr class="divider" />

    <div class="kpi-grid">
      <KPIStat
        label="Urlaub genommen"
        value={fmtDaysDe(kpis.vacationTakenDays)}
        unit="Tage"
        delta={`bis ${fmtDateDe(kpis.vacationAsOf)}`}
        deltaTone="neutral"
      />
      <KPIStat
        label="Urlaub genehmigt"
        value={fmtDaysDe(kpis.vacationApprovedDays)}
        unit="Tage"
        delta={`nach ${fmtDateDe(kpis.vacationAsOf)}, Urlaubsjahr ${kpis.vacationYear}`}
        deltaTone="neutral"
      />
      <KPIStat
        label="Urlaubsanspruch"
        value={fmtDaysDe(kpis.vacationEntitlementDays)}
        unit="Tage"
        delta={`Urlaubsjahr ${kpis.vacationYear}`}
        deltaTone="neutral"
      />
      <KPIStat
        label="Krankheitstage"
        value={fmtDaysDe(kpis.sickDays)}
        unit="Tage"
        delta="Kalendertage"
        deltaTone="neutral"
      />
    </div>

    {#if salonWorkedMinutes !== null}
      <hr class="divider" />

      <div class="kpi-grid" data-testid="period-kpis-salon-hours">
        <KPIStat
          label={SALON_WORKED_LABEL}
          value={fmtHoursDe(salonWorkedMinutes)}
          unit="h"
          delta={SALON_WORKED_DELTA_NOTE}
          deltaTone="neutral"
        />
      </div>
    {/if}

    {#if forecastNote || filterActive}
      <div class="period-kpi-notes">
        {#if forecastNote}
          <p class="period-kpi-note" data-testid="period-kpis-forecast-note">
            Offene Monate sind eine Prognose und ändern sich bis zum Monatsabschluss.
          </p>
        {/if}
        {#if filterActive}
          <div class="callout brand" data-testid="period-kpis-salon-note">
            <p>{PERSON_SALDO_BY_HOME_SALON_LABEL}. {HOME_SALON_CHANGE_NOTE}</p>
            {#if withoutHomeSalonCount !== null && withoutHomeSalonCount > 0}
              <p data-testid="period-kpis-without-home-salon">
                {withoutHomeSalonNote(withoutHomeSalonCount)}
              </p>
            {/if}
          </div>
        {/if}
      </div>
    {/if}
  {/if}
</div>

<style>
  .period-kpis {
    display: flex;
    flex-direction: column;
    gap: var(--s-4);
  }

  .kpi-grid {
    display: grid;
    grid-template-columns: repeat(4, minmax(0, 1fr));
    column-gap: var(--s-6);
    row-gap: var(--s-4);
  }

  .kpi-skeleton {
    height: 3rem;
  }

  /* The recipe's 38 px value does not fit four tiles next to the sidebar: 20 px below 1440 px and
     the unit may wrap below the figure instead of overflowing (UI-SPEC "KPI value size"). */
  @media (max-width: 1439px) {
    .period-kpis :global(.kpi-value) {
      font-size: 20px;
      flex-wrap: wrap;
    }
  }

  @media (min-width: 1280px) {
    .kpi-grid {
      column-gap: var(--s-8);
    }
  }

  @media (max-width: 960px) {
    .kpi-grid {
      grid-template-columns: repeat(2, minmax(0, 1fr));
    }
  }

  .period-kpi-notes {
    display: flex;
    flex-direction: column;
    gap: var(--s-2);
  }

  .period-kpi-note {
    margin: 0;
    font-size: 12px;
    line-height: 1.4;
    color: var(--text-muted);
  }
</style>

<script lang="ts">
  // Issue #714 - the salon viewpoint of the period report: who worked how many hours in the chosen
  // salon. Names and hours only: no Soll, no saldo, no status and no link, because the hours of a
  // person in ONE salon are never a saldo (a saldo is the whole person's, shown in the table
  // above). Group 1 is the Stammsalon persons with salon hours, group 2 the Aushilfen - persons of
  // other salons - who worked here. The total is the server's `kpis.salonWorkedMinutes`; this
  // component adds nothing. Helpers have no drill-down: the drill-down shows the whole-person
  // saldo of a person outside the Stammsalon circle.
  import EmptyState from "$components/ui/EmptyState.svelte";
  import Card from "$components/ui/Card.svelte";
  import CardHeader from "$components/ui/CardHeader.svelte";
  import { fmtHoursDe } from "$lib/reports/period-format";
  import type { PeriodHelper, PeriodRow } from "$lib/reports/period-report";
  import {
    SALON_HELPERS_HEADING,
    SALON_HELPERS_REACH_NOTE,
    SALON_WORKED_LABEL,
  } from "$lib/salons/page-scope";

  interface Props {
    /** The period rows (the Stammsalon persons); only those with salon hours are listed. */
    rows: PeriodRow[];
    /** Persons of other salons with hours in the chosen salon, in the server's order. */
    helpers: PeriodHelper[];
    /** `kpis.salonWorkedMinutes` - the server's total, shown as is. */
    totalMinutes: number | null;
    /** Whether the helper list covers the whole tenant or only the reader's reach. */
    helpersReach: "WHOLE_TENANT" | "SCOPED" | null;
    /** The period label shown under the heading. */
    periodLabel: string;
    /** A request is in flight. */
    loading?: boolean;
  }

  let { rows, helpers, totalMinutes, helpersReach, periodLabel, loading = false }: Props = $props();

  const own = $derived(rows.filter((r) => (r.salonWorkedMinutes ?? 0) > 0));
  const nobody = $derived(own.length === 0 && helpers.length === 0);
</script>

<Card animate class="salon-worked">
  <CardHeader title={SALON_WORKED_LABEL} sub={periodLabel} />
  <div class="salon-worked-body" data-testid="salon-worked-section" aria-busy={loading}>
    {#if nobody}
      <EmptyState icon="users" title="Im Zeitraum hat niemand in diesem Salon gearbeitet." />
    {:else}
      {#if own.length > 0}
        <div class="table-wrap">
          <table class="data-table data-table--compact" data-testid="salon-worked-own">
            <caption class="sr-only"
              >{SALON_WORKED_LABEL}: Personen dieses Salons, {periodLabel}</caption
            >
            <thead>
              <tr>
                <th scope="col">Person</th>
                <th scope="col" class="num">Stunden (h)</th>
              </tr>
            </thead>
            <tbody>
              {#each own as row (row.employeeId)}
                <tr>
                  <th scope="row" class="salon-worked-person">
                    {row.employeeName}
                    <span class="form-hint">{row.employeeNumber}</span>
                  </th>
                  <td class="num">{fmtHoursDe(row.salonWorkedMinutes ?? 0)}</td>
                </tr>
              {/each}
            </tbody>
          </table>
        </div>
      {:else}
        <p class="form-hint">Niemand aus diesem Salon hat im Zeitraum Stunden im Salon.</p>
      {/if}

      <h3 class="salon-worked-sub">{SALON_HELPERS_HEADING}</h3>
      {#if helpers.length > 0}
        <div class="table-wrap">
          <table class="data-table data-table--compact" data-testid="salon-worked-helpers">
            <caption class="sr-only">{SALON_HELPERS_HEADING}, {periodLabel}</caption>
            <thead>
              <tr>
                <th scope="col">Person</th>
                <th scope="col" class="num">Stunden (h)</th>
              </tr>
            </thead>
            <tbody>
              {#each helpers as helper (helper.employeeId)}
                <tr>
                  <th scope="row" class="salon-worked-person">
                    {helper.employeeName}
                    <span class="form-hint">{helper.employeeNumber}</span>
                  </th>
                  <td class="num">{fmtHoursDe(helper.salonWorkedMinutes)}</td>
                </tr>
              {/each}
            </tbody>
          </table>
        </div>
      {:else}
        <p class="form-hint">Keine Aushilfen aus anderen Salons im Zeitraum.</p>
      {/if}

      {#if totalMinutes !== null}
        <p class="salon-worked-total" data-testid="salon-worked-total">
          <span>Summe</span>
          <strong>{fmtHoursDe(totalMinutes)} h</strong>
        </p>
      {/if}
    {/if}

    {#if helpersReach === "SCOPED"}
      <p class="form-hint" data-testid="salon-worked-reach-note">{SALON_HELPERS_REACH_NOTE}</p>
    {/if}
  </div>
</Card>

<style>
  .salon-worked-body {
    display: flex;
    flex-direction: column;
    gap: var(--s-3);
  }

  .salon-worked-sub {
    margin: var(--s-2) 0 0;
    font-size: 15px;
    font-weight: 600;
    color: var(--text);
  }

  .salon-worked-person {
    text-align: left;
    font-weight: 400;
    text-transform: none;
    letter-spacing: normal;
  }

  .salon-worked-person .form-hint {
    display: block;
  }

  .num {
    text-align: right;
    white-space: nowrap;
    font-variant-numeric: tabular-nums;
  }

  .salon-worked-total {
    display: flex;
    justify-content: space-between;
    gap: var(--s-3);
    margin: 0;
    font-size: 15px;
    color: var(--text);
    font-variant-numeric: tabular-nums;
  }
</style>

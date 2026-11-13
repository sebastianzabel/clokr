<script lang="ts">
  // Issue #714 - the salon viewpoint of the period report: who worked how many hours in the chosen
  // salon. Names and hours only: no Soll, no saldo, no status and no link, because the hours of a
  // person in ONE salon are never a saldo (a saldo is the whole person's, shown in the table
  // above). Group 1 is the Stammsalon persons with salon hours, group 2 the Aushilfen - persons of
  // other salons - who worked here. The total is the server's `kpis.salonWorkedMinutes`; this
  // component adds nothing. Helpers have no drill-down: the drill-down shows the whole-person
  // saldo of a person outside the Stammsalon circle.
  import DataTable, { type DataTableColumn } from "$components/ui/DataTable.svelte";
  import EmptyState from "$components/ui/EmptyState.svelte";
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

  // DataTable's row type is a string-keyed record; the interfaces of the period answer have no
  // index signature, so both lists are shown as the intersection with a record.
  type SalonRow = {
    employeeId: string;
    employeeName: string;
    employeeNumber: string;
    minutes: number;
  } & Record<string, unknown>;

  const own = $derived(
    rows
      .filter((r) => (r.salonWorkedMinutes ?? 0) > 0)
      .map((r): SalonRow => ({
        employeeId: r.employeeId,
        employeeName: r.employeeName,
        employeeNumber: r.employeeNumber,
        minutes: r.salonWorkedMinutes ?? 0,
      })),
  );
  const helperRows = $derived(
    helpers.map((h): SalonRow => ({
      employeeId: h.employeeId,
      employeeName: h.employeeName,
      employeeNumber: h.employeeNumber,
      minutes: h.salonWorkedMinutes,
    })),
  );
  const nobody = $derived(own.length === 0 && helpers.length === 0);

  const columns: DataTableColumn[] = [
    { key: "person", label: "Person", primary: true },
    { key: "hours", label: "Stunden (h)", align: "end" },
  ];
</script>

{#snippet cell(row: SalonRow, column: DataTableColumn)}
  {#if column.key === "person"}
    <span class="salon-worked-person">
      {row.employeeName}
      <span class="salon-worked-number">{row.employeeNumber}</span>
    </span>
  {:else}
    {fmtHoursDe(row.minutes)}
  {/if}
{/snippet}

<section class="settings-group salon-worked" aria-labelledby="salon-worked-title">
  <div>
    <h2 class="settings-group-title" id="salon-worked-title">{SALON_WORKED_LABEL}</h2>
    <p class="settings-group-desc salon-worked-period">{periodLabel}</p>
  </div>
  <div class="salon-worked-body" data-testid="salon-worked-section" aria-busy={loading}>
    {#if nobody}
      <EmptyState icon="users" title="Im Zeitraum hat niemand in diesem Salon gearbeitet." />
    {:else}
      {#if own.length > 0}
        <div data-testid="salon-worked-own">
          <DataTable
            {columns}
            rows={own}
            rowKey={(row) => row.employeeId}
            {cell}
            caption={`${SALON_WORKED_LABEL}: Personen dieses Salons, ${periodLabel}`}
          />
        </div>
      {:else}
        <p class="settings-group-desc salon-worked-calm">
          Niemand aus diesem Salon hat im Zeitraum Stunden im Salon.
        </p>
      {/if}

      <h3 class="salon-worked-sub">{SALON_HELPERS_HEADING}</h3>
      {#if helpers.length > 0}
        <div data-testid="salon-worked-helpers">
          <DataTable
            {columns}
            rows={helperRows}
            rowKey={(row) => row.employeeId}
            {cell}
            caption={`${SALON_HELPERS_HEADING}, ${periodLabel}`}
          />
        </div>
      {:else}
        <p class="settings-group-desc salon-worked-calm">
          Keine Aushilfen aus anderen Salons im Zeitraum.
        </p>
      {/if}

      {#if totalMinutes !== null}
        <p class="salon-worked-total" data-testid="salon-worked-total">
          <span>Summe</span>
          <strong>{fmtHoursDe(totalMinutes)} h</strong>
        </p>
      {/if}
    {/if}

    {#if helpersReach === "SCOPED"}
      <p class="settings-group-desc salon-worked-calm" data-testid="salon-worked-reach-note">
        {SALON_HELPERS_REACH_NOTE}
      </p>
    {/if}
  </div>
</section>

<style>
  .salon-worked-period {
    margin-top: var(--s-1);
  }

  .salon-worked-body {
    display: flex;
    flex-direction: column;
    gap: var(--s-3);
  }

  .salon-worked-calm {
    margin-top: 0;
  }

  .salon-worked-sub {
    margin: var(--s-2) 0 0;
    font-size: var(--fs-base);
    font-weight: 600;
    color: var(--text);
  }

  .salon-worked-person {
    display: flex;
    flex-direction: column;
    padding-block: var(--s-1);
  }

  .salon-worked-number {
    font-size: var(--fs-sm);
    font-weight: 400;
    color: var(--text-2);
  }

  .salon-worked-total {
    display: flex;
    justify-content: space-between;
    gap: var(--s-3);
    margin: 0;
    color: var(--text);
    font-variant-numeric: tabular-nums;
  }
</style>

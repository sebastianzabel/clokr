<script lang="ts">
  // Issue #613 (AC-613-5): persons who have left and whose exit month is not closed yet. Their final
  // saldo stays visible here until a manager closes that month. The server chose the rows, their
  // order and their bound; this component displays them and says how many are not shown.
  import Icon from "$components/Icon.svelte";
  import DataTable, { type DataTableColumn } from "$components/ui/DataTable.svelte";
  import {
    exitDateLabel,
    exitedMoreCount,
    type ExitedOverviewRow,
  } from "$lib/reports/overtime-overview-sections";
  import { forecastColumnLabel, teamSaldoCells } from "$lib/reports/team-saldo"; // Issue #588

  interface Props {
    rows: ExitedOverviewRow[];
    /** All exited persons with an open final saldo in the caller's reach (may exceed `rows`). */
    total: number;
    /**
     * Issue #612 - an optional line naming the section's reference day, for a page whose other
     * blocks follow a chosen period ("Stand heute, unabhängig vom Zeitraum"). Absent: no line.
     */
    asOfNote?: string;
  }

  let { rows, total, asOfNote }: Props = $props();

  let more = $derived(exitedMoreCount(total, rows.length));
  // Issue #588 (D-588-4): the forecast header names the window the rows really have.
  let forecastHeader = $derived(forecastColumnLabel(rows));

  // DataTable's row type is a string-keyed record; the interface of the overview row has no index
  // signature, so the shown rows carry the intersection.
  type TableRow = ExitedOverviewRow & Record<string, unknown>;

  const columns = $derived<DataTableColumn[]>([
    { key: "name", label: "Mitarbeiter", primary: true },
    { key: "employeeNumber", label: "Nr." },
    { key: "exitDate", label: "Austritt am" },
    { key: "confirmed", label: "Abgeschlossen", align: "end" },
    { key: "open", label: forecastHeader, align: "end" },
    { key: "total", label: "Gesamt", align: "end" },
  ]);
</script>

{#snippet cell(row: TableRow, column: DataTableColumn)}
  {@const cells = teamSaldoCells(row)}
  {#if column.key === "name"}
    {row.name}
  {:else if column.key === "employeeNumber"}
    {row.employeeNumber}
  {:else if column.key === "exitDate"}
    <span data-testid="exit-date">{exitDateLabel(row.exitDate)}</span>
  {:else if column.key === "confirmed"}
    <span data-testid="saldo-cell-confirmed" title={cells.confirmed.title}
      >{cells.confirmed.text}</span
    >
  {:else if column.key === "open"}
    <span data-testid="saldo-cell-open" title={cells.open.title}>{cells.open.text}</span>
    {#if row.rosterIncomplete}
      <span class="roster-dot" data-testid="saldo-roster-badge">
        <Icon name="circle-fill" size={6} title="Restmonat noch nicht vollständig verplant" />
      </span>
    {/if}
  {:else if column.key === "total"}
    <span data-testid="saldo-cell-total" title={cells.total.title}>{cells.total.text}</span>
  {/if}
{/snippet}

{#if rows.length > 0 || total > 0}
  <section class="exited-section" data-testid="exited-final-saldo">
    <h3 class="settings-group-title">Ausgetreten, offener Endsaldo ({total})</h3>
    <p class="settings-group-desc">
      Der Endsaldo ist bestätigt, sobald der Austrittsmonat abgeschlossen ist.
    </p>
    {#if asOfNote}
      <p class="settings-group-desc" data-testid="exited-as-of">{asOfNote}</p>
    {/if}
    {#if rows.length > 0}
      <DataTable
        {columns}
        rows={rows as TableRow[]}
        rowKey={(row) => row.id}
        {cell}
        caption="Ausgetreten mit offenem Endsaldo"
      />
    {/if}
    {#if more > 0}
      <p class="settings-group-desc exited-more" data-testid="exited-more">und {more} weitere</p>
    {/if}
  </section>
{/if}

<style>
  .exited-section {
    display: flex;
    flex-direction: column;
    gap: var(--s-3);
    margin-top: var(--s-4);
  }

  .exited-more {
    margin-top: 0;
  }

  .roster-dot {
    display: inline-flex;
    align-items: center;
    color: var(--warn);
  }
</style>

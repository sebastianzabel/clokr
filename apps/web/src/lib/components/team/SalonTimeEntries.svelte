<script lang="ts">
  // Issue #85 D-09 — the Salonansicht of `/team/time-entries`: every entry recorded in one salon
  // for the shown month, grouped by day and person. Presentation only (the server decides what is
  // visible) and per-entry details only — it sums nothing, by design (see salon-time-entries.ts).
  // Issue #853 (owner review): one table for the month, in the column pattern of the person view.
  // Mountable: no `$app` import, no request; the page loads the data and passes the status.
  import { format } from "date-fns";
  import type { SalonViewDay, SalonViewEntry, SalonViewStatus } from "$lib/team/salon-time-entries";
  import { salonNameLabel } from "$lib/salons/page-scope";
  import SalonScopeLabel from "./SalonScopeLabel.svelte";
  import { TRAVEL_TEXTS, isTravelRow, travelRouteLabel } from "$lib/time-entries/travel-entry-form";
  import Skeleton from "$components/ui/Skeleton.svelte";
  import DataTable, { type DataTableColumn } from "$components/ui/DataTable.svelte";
  import Chip from "$components/ui/Chip.svelte";
  import { fmtMin } from "$lib/utils/format-minutes";
  import { weekdayDateLabel } from "$lib/team/zeiten-day-rows";

  interface Props {
    days: SalonViewDay[];
    status: SalonViewStatus;
    /** D-15: the server cut the list at its row cap. */
    capReached?: boolean;
    salonName?: string | null;
  }

  let { days, status, capReached = false, salonName = null }: Props = $props();

  // A type alias, because DataTable's row generic wants an index-signature-compatible type.
  type EntryRow = {
    id: string;
    day: string;
    dayLabel: string;
    name: string;
    entry: SalonViewEntry;
  };

  // Issue #853 (owner review): the pattern of the person view - one table, Tag first, then the
  // person, the times, the stored break and the working time as H:MM, a quiet status chip; no row
  // is tinted. Still per entry and without any sum (#85).
  const COLUMNS: DataTableColumn[] = [
    { key: "day", label: "Tag", primary: true },
    { key: "name", label: "Person" },
    { key: "times", label: "Zeiten" },
    { key: "break", label: "Pause", align: "end" },
    { key: "work", label: "Netto", align: "end" },
    { key: "state", label: "Status", align: "end" },
  ];

  const rows = $derived<EntryRow[]>(
    days.flatMap((day) =>
      day.persons.flatMap((person) =>
        person.entries.map((entry) => ({
          id: entry.id,
          day: day.dateKey,
          dayLabel: weekdayDateLabel(day.dateKey),
          name: person.name,
          entry,
        })),
      ),
    ),
  );

  function time(iso: string): string {
    return format(new Date(iso), "HH:mm");
  }
</script>

<div class="salon-view" data-testid="salon-time-entries">
  {#if status === "loading"}
    <Skeleton shape="row" count={5} />
  {:else if status === "prompt"}
    <div class="callout brand" role="status">
      <p>Wähl in der Kopfleiste einen Salon, um seine Einträge zu sehen.</p>
    </div>
  {:else if status === "rejected"}
    <div class="callout" role="status">
      <p>
        Für diesen Salon liegt keine Salonansicht vor. Wähl in der Kopfleiste einen anderen Salon.
      </p>
    </div>
  {:else if status === "empty"}
    <div class="callout" role="status">
      <p>In diesem Monat sind in diesem Salon keine Einträge erfasst.</p>
    </div>
  {:else if status === "rows"}
    {#if capReached}
      <div class="callout" role="status">
        <p>
          Es werden höchstens 1000 Einträge angezeigt; die Liste für diesen Monat ist unvollständig.
        </p>
      </div>
    {/if}
    {#if salonName}
      <SalonScopeLabel label={salonNameLabel(salonName)} />
    {/if}
    <DataTable
      columns={COLUMNS}
      {rows}
      rowKey={(row) => row.id}
      caption={salonName ? `Einträge in ${salonName}` : "Einträge im Salon"}
    >
      {#snippet cell(row, column)}
        {@const entry = row.entry}
        {#if column.key === "day"}
          {row.dayLabel}
        {:else if column.key === "name"}
          {row.name}{#if isTravelRow(entry)}
            <Chip>{TRAVEL_TEXTS.badge}</Chip>
            <span class="salon-view-route">{travelRouteLabel(entry)}</span>{/if}
        {:else if column.key === "times"}
          {entry.endTime
            ? `${time(entry.startTime)}–${time(entry.endTime)}`
            : `ab ${time(entry.startTime)}`}
        {:else if column.key === "break"}
          <!-- a running entry's stored break is not final yet and is never shown -->
          {entry.endTime && entry.breakMinutes > 0 ? fmtMin(entry.breakMinutes) : "–"}
        {:else if column.key === "work"}
          {entry.workingMinutes === null ? "–" : fmtMin(entry.workingMinutes)}
        {:else if column.key === "state"}
          {#if !entry.endTime}
            <Chip>offen</Chip>
          {:else if entry.isInvalid}
            <Chip tone="warn">ungültig</Chip>
          {/if}
        {/if}
      {/snippet}
    </DataTable>
  {/if}
</div>

<style>
  .salon-view {
    display: flex;
    flex-direction: column;
    gap: 1rem;
  }
  .salon-view-route {
    display: inline-block;
    overflow-wrap: break-word;
  }
</style>

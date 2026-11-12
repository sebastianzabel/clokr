<script lang="ts">
  // Issue #85 D-09 — the Salonansicht of `/team/time-entries`: every entry recorded in one salon
  // for the shown month, grouped by day and person. Presentation only (the server decides what is
  // visible) and per-entry details only — it sums nothing, by design (see salon-time-entries.ts).
  // Issue #853 (D-853-10, D-853-18): one TeamSection per day, each holding one DataTable.
  // Mountable: no `$app` import, no request; the page loads the data and passes the status.
  import { format } from "date-fns";
  import type { SalonViewDay, SalonViewEntry, SalonViewStatus } from "$lib/team/salon-time-entries";
  import { salonNameLabel } from "$lib/salons/page-scope";
  import SalonScopeLabel from "./SalonScopeLabel.svelte";
  import { TRAVEL_TEXTS, isTravelRow, travelRouteLabel } from "$lib/time-entries/travel-entry-form";
  import Skeleton from "$components/ui/Skeleton.svelte";
  import DataTable, { type DataTableColumn } from "$components/ui/DataTable.svelte";
  import Chip from "$components/ui/Chip.svelte";
  import TeamSection from "./TeamSection.svelte";

  interface Props {
    days: SalonViewDay[];
    status: SalonViewStatus;
    /** D-15: the server cut the list at its row cap. */
    capReached?: boolean;
    salonName?: string | null;
  }

  let { days, status, capReached = false, salonName = null }: Props = $props();

  // A type alias, because DataTable's row generic wants an index-signature-compatible type.
  type DayRow = { id: string; name: string; entry: SalonViewEntry };

  const COLUMNS: DataTableColumn[] = [
    // Fixed shares so the columns of the per-day tables line up from one day to the next.
    { key: "name", label: "Mitarbeiter", primary: true, width: "36%" },
    { key: "start", label: "Beginn", width: "14%" },
    { key: "end", label: "Ende", width: "14%" },
    { key: "break", label: "Pause", width: "16%" },
    { key: "work", label: "Arbeitszeit", width: "20%" },
  ];

  function rowsOf(day: SalonViewDay): DayRow[] {
    return day.persons.flatMap((person) =>
      person.entries.map((entry) => ({ id: entry.id, name: person.name, entry })),
    );
  }

  function time(iso: string): string {
    return format(new Date(iso), "HH:mm");
  }

  function hoursMinutes(minutes: number | null): string {
    if (minutes === null) return "—";
    const h = Math.floor(minutes / 60);
    const m = minutes % 60;
    return `${h}:${String(m).padStart(2, "0")}`;
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
    {#each days as day (day.dateKey)}
      <TeamSection title={day.label} headingLevel={3}>
        <DataTable
          columns={COLUMNS}
          rows={rowsOf(day)}
          rowKey={(row) => row.id}
          rowTone={(row) => (row.entry.isInvalid ? "warn" : undefined)}
          caption={`Einträge am ${day.label}`}
        >
          {#snippet cell(row, column)}
            {@const entry = row.entry}
            {#if column.key === "name"}
              {row.name}{#if isTravelRow(entry)}
                <Chip>{TRAVEL_TEXTS.badge}</Chip>
                <span class="salon-view-route">{travelRouteLabel(entry)}</span>{/if}
            {:else if column.key === "start"}
              {time(entry.startTime)}
            {:else if column.key === "end"}
              {entry.endTime ? time(entry.endTime) : "offen"}
            {:else if column.key === "break"}
              {entry.breakMinutes} min
            {:else if column.key === "work"}
              {hoursMinutes(entry.workingMinutes)}
              {#if entry.isInvalid}
                <Chip tone="warn">ungültig</Chip>
              {/if}
            {/if}
          {/snippet}
        </DataTable>
      </TeamSection>
    {/each}
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

<script lang="ts">
  // Issue #85 D-09 — the Salonansicht of `/team/time-entries`: every entry recorded in one salon
  // for the shown month, grouped by day and person. Presentation only (the server decides what is
  // visible) and per-entry details only — it sums nothing, by design (see salon-time-entries.ts).
  // Mountable: no `$app` import, no request; the page loads the data and passes the status.
  import { format } from "date-fns";
  import type { SalonViewDay, SalonViewStatus } from "$lib/team/salon-time-entries";

  interface Props {
    days: SalonViewDay[];
    status: SalonViewStatus;
    /** D-15: the server cut the list at its row cap. */
    capReached?: boolean;
    salonName?: string | null;
  }

  let { days, status, capReached = false, salonName = null }: Props = $props();

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
    <p class="salon-view-note" role="status">Wird geladen …</p>
  {:else if status === "rows"}
    {#if salonName}
      <p class="salon-view-salon">Salon: {salonName}</p>
    {/if}
    {#each days as day (day.dateKey)}
      <section class="card salon-view-day">
        <h3 class="salon-view-day-title">{day.label}</h3>
        <div class="table-wrapper">
          <table class="data-table">
            <thead>
              <tr>
                <th>Mitarbeiter</th>
                <th>Beginn</th>
                <th>Ende</th>
                <th>Pause</th>
                <th>Arbeitszeit</th>
              </tr>
            </thead>
            <tbody>
              {#each day.persons as person (person.employeeId)}
                {#each person.entries as entry (entry.id)}
                  <tr>
                    <td>{person.name}</td>
                    <td>{time(entry.startTime)}</td>
                    <td>{entry.endTime ? time(entry.endTime) : "offen"}</td>
                    <td>{entry.breakMinutes} min</td>
                    <td>
                      {hoursMinutes(entry.workingMinutes)}
                      {#if entry.isInvalid}
                        <span class="badge badge-gray">ungültig</span>
                      {/if}
                    </td>
                  </tr>
                {/each}
              {/each}
            </tbody>
          </table>
        </div>
      </section>
    {/each}
  {/if}
</div>

<style>
  .salon-view {
    display: flex;
    flex-direction: column;
    gap: 1rem;
  }
  .salon-view-day {
    padding: 1rem;
  }
  .salon-view-day-title {
    margin: 0 0 0.75rem;
    font-size: 1rem;
    font-weight: 600;
    color: var(--text);
  }
  .salon-view-salon,
  .salon-view-note {
    margin: 0;
    color: var(--text-muted);
    font-size: 0.875rem;
  }
</style>

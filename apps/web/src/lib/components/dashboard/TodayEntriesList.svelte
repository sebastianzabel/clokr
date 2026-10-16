<!--
  Issue #70 (D-07): the compact list of today's entries on the "Heutiger Eintrag" card, shown only
  for multi-salon tenants with two or more entries. One line per entry — „07:00–11:00 · Salon A“ for a
  closed entry, „seit 11:30 · Salon B“ for the running one. Display only: the salon name is the
  server's `salonName`, never looked up or decided here.
-->
<script lang="ts">
  import {
    entriesInStartOrder,
    entryRangeLabel,
    type ClockDayEntry,
  } from "$lib/dashboard/day-state";

  interface Props {
    entries: ClockDayEntry[];
  }

  let { entries }: Props = $props();

  let rows = $derived(
    entriesInStartOrder(entries).map((entry) => ({
      id: entry.id,
      label: entry.salonName
        ? `${entryRangeLabel(entry)} · ${entry.salonName}`
        : entryRangeLabel(entry),
    })),
  );
</script>

<ul class="today-entries" aria-label="Einträge von heute">
  {#each rows as row (row.id)}
    <li class="today-entries-row">{row.label}</li>
  {/each}
</ul>

<style>
  .today-entries {
    list-style: none;
    margin: 0 0 12px;
    padding: 0;
    border-top: 1px solid var(--border);
  }
  .today-entries-row {
    padding: 8px 0;
    border-bottom: 1px solid var(--border);
    font-size: 14px;
    font-variant-numeric: tabular-nums;
    color: var(--text);
    overflow-wrap: anywhere;
  }
</style>

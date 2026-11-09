<script module lang="ts">
  // Issue #843 (D-843-04) - demo of block 2. `entries` are relative to apps/web/src/lib.
  export const block = {
    id: 2,
    name: "Periodenwahl",
    entries: ["components/ui/PeriodPicker.svelte"],
  };
</script>

<script lang="ts">
  import PeriodPicker from "$components/ui/PeriodPicker.svelte";
  import type { PeriodZoom } from "$components/ui/PeriodPicker.svelte";

  const MONTHS = ["Oktober 2026", "November 2026", "Dezember 2026"];
  const WEEKS = ["KW 45 · 2.–8.11.2026", "KW 46 · 9.–15.11.2026", "KW 47 · 16.–22.11.2026"];

  let zoom = $state<PeriodZoom>("monat");
  let monthIndex = $state(1);
  let weekIndex = $state(1);

  function step(index: number, by: -1 | 1, length: number): number {
    return Math.min(length - 1, Math.max(0, index + by));
  }
</script>

<div data-block="2">
  <PeriodPicker
    testIdPrefix="demo-period-zoom"
    label={MONTHS[monthIndex]}
    zooms={["jahr", "quartal", "monat", "woche"]}
    bind:zoom
    onPrev={() => (monthIndex = step(monthIndex, -1, MONTHS.length))}
    onNext={() => (monthIndex = step(monthIndex, 1, MONTHS.length))}
    onToday={() => (monthIndex = 1)}
    prevLabel="Vorheriger Zeitraum"
    nextLabel="Nächster Zeitraum"
  />

  <PeriodPicker
    testIdPrefix="demo-period-week"
    label={WEEKS[weekIndex]}
    zooms={["woche"]}
    onPrev={() => (weekIndex = step(weekIndex, -1, WEEKS.length))}
    onNext={() => (weekIndex = step(weekIndex, 1, WEEKS.length))}
    prevLabel="Vorherige Woche"
    nextLabel="Nächste Woche"
  />
</div>

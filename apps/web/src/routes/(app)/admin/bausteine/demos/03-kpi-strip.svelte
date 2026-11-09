<script module lang="ts">
  // Issue #843 (D-843-04) - demo of block 3. `entries` are relative to apps/web/src/lib.
  export const block = {
    id: 3,
    name: "Kennzahlenleiste",
    entries: ["components/ui/KpiStrip.svelte", "components/ui/KpiCell.svelte"],
  };
</script>

<script lang="ts">
  import KpiStrip from "$components/ui/KpiStrip.svelte";
  import type { KpiItem } from "$components/ui/KpiStrip.svelte";

  const oneDecimal = (n: number) =>
    n.toLocaleString("de-DE", { minimumFractionDigits: 1, maximumFractionDigits: 1 });

  const PLAIN: KpiItem[] = [
    { label: "Soll", value: "160:00", unit: "h" },
    { label: "Ist", value: "152:30", unit: "h" },
    { label: "Saldo", value: "−7:30", unit: "h", explanation: "bis gestern" },
  ];

  const BAND: KpiItem[] = [
    {
      label: "Resturlaub",
      value: 12.5,
      format: oneDecimal,
      unit: "Tage",
      explanation: "Stand 9.11.2026",
      derivationHref: "#",
    },
    { label: "Genommen", value: 17.5, format: oneDecimal, unit: "Tage" },
    { label: "Geplant", value: "5", unit: "Tage" },
  ];
</script>

<div data-block="3" class="strips-demo">
  <KpiStrip items={PLAIN} ariaLabel="Zeitkonto" />
  <KpiStrip items={BAND} band ariaLabel="Urlaub" />
</div>

<style>
  .strips-demo {
    display: flex;
    flex-direction: column;
    gap: var(--s-4);
  }
</style>

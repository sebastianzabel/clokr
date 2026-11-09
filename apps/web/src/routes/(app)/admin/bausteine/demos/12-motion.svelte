<script module lang="ts">
  // Issue #843 (D-843-04) - demo of block 12. `entries` are relative to apps/web/src/lib.
  export const block = {
    id: 12,
    name: "Bewegung",
    entries: ["motion/index.ts"],
  };
</script>

<script lang="ts">
  import { countUp, stagger } from "$lib/motion";

  const ITEMS = ["Dienstplan", "Zeiten", "Abwesenheiten", "Berichte", "Einstellungen"];
  const HOURS = 152.5;

  const fmtHours = (n: number) =>
    `${n.toLocaleString("de-DE", { minimumFractionDigits: 1, maximumFractionDigits: 1 })} h`;
</script>

<div data-block="12" class="motion-demo">
  <ul class="motion-list">
    {#each ITEMS as item, index (item)}
      <li class="motion-item card-animate" use:stagger={{ index }}>{item}</li>
    {/each}
  </ul>
  <p class="motion-figure">
    Ist: <strong use:countUp={{ value: HOURS, format: fmtHours }}>{fmtHours(HOURS)}</strong>
  </p>
</div>

<style>
  .motion-demo {
    display: flex;
    flex-direction: column;
    gap: var(--s-3);
  }
  .motion-list {
    display: flex;
    flex-direction: column;
    gap: var(--s-2);
    margin: 0;
    padding: 0;
    list-style: none;
  }
  .motion-item {
    padding: var(--s-2) var(--s-3);
    background: var(--card);
    border: 1px solid var(--line);
    border-radius: var(--r-control);
    color: var(--text);
    font-size: var(--fs-base);
  }
  .motion-figure {
    margin: 0;
    color: var(--text-2);
    font-size: var(--fs-base);
    font-variant-numeric: tabular-nums;
  }
  .motion-figure strong {
    color: var(--text);
    font-weight: 600;
  }
</style>

<script lang="ts">
  // Issue #843 (D-843-01 block 3, D-843-03) - the Kennzahlenleiste: Kennzahlen in a row, each
  // label - value - explanation - optional "Herleitung" link (KpiCell). The root is the container:
  // one row from 1100 px, columns of at least 160 px between 760 and 1100, two columns below 760.
  // `band` tints the strip with --brand-tint (text, text-2, text-3, brand and the status colours
  // reach 4.5:1 on it in all six combinations, proven in KpiStrip-843.test.ts).
  import type { Snippet } from "svelte";
  import KpiCell from "./KpiCell.svelte";
  import type { KpiProgress } from "./KpiCell.svelte";

  export interface KpiItem {
    label: string;
    value: string | number;
    format?: (n: number) => string;
    unit?: string;
    explanation?: string;
    derivationHref?: string;
    delta?: string;
    deltaTone?: "good" | "bad" | "warn" | "neutral";
    progress?: KpiProgress;
    testId?: string;
  }

  interface Props {
    items: KpiItem[];
    /** Tinted band variant. */
    band?: boolean;
    ariaLabel?: string;
    /**
     * Issue #851 (additive): one more cell for a figure the label/value shape cannot express (the
     * two-figure saldo of SaldoAnzeige). Rendered after the items inside the same grid, padded like
     * a cell; counted in the one-row column count.
     */
    extra?: Snippet;
  }

  let { items, band = false, ariaLabel, extra }: Props = $props();
</script>

<div
  class="kpi-strip"
  class:kpi-strip--band={band}
  role={ariaLabel ? "group" : undefined}
  aria-label={ariaLabel}
>
  <div class="kpi-strip-grid" style="--kpi-count: {Math.max(1, items.length + (extra ? 1 : 0))}">
    {#each items as item, index (index)}
      <KpiCell
        strip
        label={item.label}
        value={item.value}
        format={item.format}
        unit={item.unit}
        explanation={item.explanation}
        derivationHref={item.derivationHref}
        delta={item.delta}
        deltaTone={item.deltaTone}
        progress={item.progress}
        testId={item.testId}
      />
    {/each}
    {#if extra}<div class="kpi-strip-extra">{@render extra()}</div>{/if}
  </div>
</div>

<style>
  .kpi-strip {
    container-type: inline-size;
    background: var(--card);
    border: 1px solid var(--line);
    border-radius: var(--r-card);
  }
  .kpi-strip--band {
    background: var(--brand-tint);
  }
  /* The label colour of app.css (--text-3) is proven on the neutral surfaces; on the tinted band
     the secondary text colour is the safe one. */
  .kpi-strip--band :global(.kpi-label) {
    color: var(--text-2);
  }

  .kpi-strip-extra {
    min-width: 0;
    padding: var(--s-3) var(--s-4);
  }
  /* Two columns below 760 px: the extra cell (a wider figure) takes the whole row (#564 overflow). */
  @container (max-width: 759.98px) {
    .kpi-strip-extra {
      grid-column: 1 / -1;
    }
  }

  .kpi-strip-grid {
    display: grid;
    grid-template-columns: repeat(2, minmax(0, 1fr));
  }
  @container (min-width: 760px) {
    .kpi-strip-grid {
      grid-template-columns: repeat(auto-fit, minmax(160px, 1fr));
    }
  }
  @container (min-width: 1100px) {
    .kpi-strip-grid {
      grid-template-columns: repeat(var(--kpi-count), minmax(0, 1fr));
    }
  }
</style>

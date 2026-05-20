<script lang="ts">
  /**
   * KPIStat — pure-props KPI tile primitive (D-02).
   *
   * Wraps the canonical `.kpi` recipe (label + value + optional unit + optional
   * delta) defined in `apps/web/src/app.css`. No slots, no children — callers
   * format values themselves and pass strings only.
   *
   * The component intentionally does NOT modify `app.css`. Any tone class that
   * is not present in the global stylesheet is encapsulated below in the
   * scoped style block so the primitive is self-contained.
   */
  interface Props {
    /** 11px UPPERCASE faint caption above the value. */
    label: string;
    /** Pre-formatted main value (serif 38px). */
    value: string;
    /** Optional unit/suffix rendered inside `.kpi-value` (e.g. "von 30", "h"). */
    unit?: string;
    /** Optional delta line below the value (e.g. "+3.5h"). */
    delta?: string;
    /** Semantic tone for the delta. `"neutral"` (default) renders without tone modifier. */
    deltaTone?: "good" | "bad" | "warn" | "neutral";
  }

  let { label, value, unit, delta, deltaTone = "neutral" }: Props = $props();

  const deltaClass = $derived(
    deltaTone === "neutral" ? "kpi-delta" : `kpi-delta kpi-delta-${deltaTone}`,
  );
</script>

<article class="kpi">
  <div class="kpi-label">{label}</div>
  <div class="kpi-value">
    {value}{#if unit}<span class="kpi-unit"> {unit}</span>{/if}
  </div>
  {#if delta}<div class={deltaClass}>{delta}</div>{/if}
</article>

<style>
  /* Scoped fallback for tone classes missing from `app.css`.
     The public `.kpi`, `.kpi-label`, `.kpi-value`, `.kpi-unit`, `.kpi-delta`,
     `.kpi-delta-good`, `.kpi-delta-bad` recipes are composed from the global
     stylesheet. Only `.kpi-delta-warn` is added here to avoid touching the
     global file from this primitive. */
  .kpi-delta-warn {
    color: var(--warn);
  }
</style>

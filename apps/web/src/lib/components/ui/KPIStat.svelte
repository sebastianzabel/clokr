<script lang="ts">
  /**
   * KPIStat — pure-props KPI tile primitive (D-02).
   *
   * Wraps the canonical `.kpi` recipe (label + value + optional unit + optional
   * delta) defined in `apps/web/src/app.css`. No slots, no children — callers
   * format values themselves and pass strings only.
   *
   * D-02 EXCEPTION (Phase 40 / UI-18): The contract is intentionally loosened by
   * one structured field — `progress?: { value, max, label? }` — to render an
   * inline 4 px progress bar (e.g. Urlaubstage "12 von 30 Tagen genommen"). The
   * shape stays declarative (no slot, no children), so the primitive remains
   * pure-props in spirit. Future consumers: leave, admin, inbox.
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
    /**
     * Optional 4 px progress bar rendered between value and delta.
     * `value / max` drives the fill width (clamped 0..100 %).
     * `label` (optional) renders as a small caption above the bar.
     * When `value >= max`, the fill uses `var(--good)` instead of `var(--brand)`.
     */
    progress?: { value: number; max: number; label?: string };
  }

  let { label, value, unit, delta, deltaTone = "neutral", progress }: Props = $props();

  const deltaClass = $derived(
    deltaTone === "neutral" ? "kpi-delta" : `kpi-delta kpi-delta-${deltaTone}`,
  );

  const progressPct = $derived(
    progress && progress.max > 0
      ? Math.max(0, Math.min(100, (progress.value / progress.max) * 100))
      : 0,
  );
  const progressFull = $derived(progress ? progress.value >= progress.max : false);
</script>

<article class="kpi">
  <div class="kpi-label">{label}</div>
  <div class="kpi-value">
    {value}{#if unit}<span class="kpi-unit"> {unit}</span>{/if}
  </div>
  {#if progress}
    {#if progress.label}
      <div class="kpi-progress-label">{progress.label}</div>
    {/if}
    <div
      class="kpi-progress-track"
      role="progressbar"
      aria-valuenow={progress.value}
      aria-valuemin="0"
      aria-valuemax={progress.max}
      aria-label={progress.label ?? label}
    >
      <div
        class="kpi-progress-fill"
        class:kpi-progress-fill-full={progressFull}
        style="width: {progressPct}%"
      ></div>
    </div>
  {/if}
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

  /* Progress bar (UI-18 / Phase 40). 4 px track + brand fill, slim caption.
     Scoped on purpose so the primitive stays self-contained — see header. */
  .kpi-progress-label {
    font-size: 11px;
    line-height: 1.2;
    color: var(--text-muted);
    margin-top: 6px;
  }
  .kpi-progress-track {
    background: var(--bg-subtle);
    border-radius: var(--r-sm);
    height: 4px;
    overflow: hidden;
    position: relative;
    margin-top: 6px;
  }
  .kpi-progress-fill {
    background: var(--brand);
    height: 100%;
    border-radius: inherit;
    transition: width 400ms var(--ease-out);
  }
  .kpi-progress-fill-full {
    background: var(--good);
  }
</style>

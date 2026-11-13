<script lang="ts">
  import KpiCell from "./KpiCell.svelte";

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
   * Issue #843 (D-843-01 block 3): the markup now lives in KpiCell (the cell KpiStrip also
   * renders); this component keeps the props and the legacy look of the 38 px tile.
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
     * When `value >= max`, the fill uses `var(--ok)` instead of `var(--brand)`.
     */
    progress?: { value: number; max: number; label?: string };
  }

  let { label, value, unit, delta, deltaTone = "neutral", progress }: Props = $props();
</script>

<KpiCell {label} {value} {unit} {delta} {deltaTone} {progress} />

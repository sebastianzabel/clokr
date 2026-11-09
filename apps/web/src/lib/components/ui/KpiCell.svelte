<script lang="ts">
  // Issue #843 (D-843-01 block 3) - ONE Kennzahl: label, value (+ unit), an explanation line, an
  // optional "Herleitung" link, an optional delta line and an optional progress bar. KpiStrip lays
  // cells out in a row; KPIStat renders a single cell with its legacy look. The classes
  // (.kpi, .kpi-label, .kpi-value, .kpi-unit, .kpi-delta[-tone]) are the app.css recipes the
  // reports and operator tests read.
  import { countUp } from "$lib/motion";

  export interface KpiProgress {
    value: number;
    max: number;
    label?: string;
  }

  interface Props {
    /** Short caption above the value. */
    label: string;
    /** A number is counted up to (and formatted with `format`); a string is shown as given. */
    value: string | number;
    /** Formats a numeric `value`; default is the plain number. */
    format?: (n: number) => string;
    /** Suffix inside the value line (e.g. "h", "Tage"). */
    unit?: string;
    /** One line that says what the figure covers (e.g. "bis gestern"). */
    explanation?: string;
    /** Where the "Herleitung" link goes; without it there is no link. */
    derivationHref?: string;
    /** Text of the derivation link. */
    derivationLabel?: string;
    /** Delta line below the value. */
    delta?: string;
    /** Tone of the delta line; "neutral" renders without a tone class. */
    deltaTone?: "good" | "bad" | "warn" | "neutral";
    /** Inline 4 px progress bar (value / max, clamped); full bars use the ok colour. */
    progress?: KpiProgress;
    /** The compact look of a cell inside a KpiStrip. */
    strip?: boolean;
    testId?: string;
  }

  let {
    label,
    value,
    format,
    unit,
    explanation,
    derivationHref,
    derivationLabel = "Herleitung →",
    delta,
    deltaTone = "neutral",
    progress,
    strip = false,
    testId,
  }: Props = $props();

  // The text the value line shows at rest; the countUp action ends on exactly this text.
  const display = $derived(
    typeof value === "number" ? (format ? format(value) : String(value)) : value,
  );

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

<article class="kpi" class:kpi-cell--strip={strip} data-testid={testId}>
  <div class="kpi-label">{label}</div>
  <div class="kpi-value" use:countUp={{ value, format }}>
    {display}{#if unit}<span class="kpi-unit"> {unit}</span>{/if}
  </div>
  {#if explanation}<div class="kpi-explanation">{explanation}</div>{/if}
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
  {#if derivationHref}<a class="kpi-derivation" href={derivationHref}>{derivationLabel}</a>{/if}
</article>

<style>
  /* Strip look: the figure is one --fs-kpi step, weight 600, tabular. The legacy tile (KPIStat)
     keeps the 38 px recipe of app.css. */
  .kpi-cell--strip {
    min-width: 0;
    padding: var(--s-3) var(--s-4);
  }
  .kpi-cell--strip .kpi-label {
    font-size: var(--fs-xs);
  }
  .kpi-cell--strip .kpi-value {
    font-size: var(--fs-kpi);
    font-weight: 600;
    line-height: 1.2;
    font-variant-numeric: tabular-nums;
  }
  .kpi-explanation {
    font-size: var(--fs-xs);
    color: var(--text-2);
  }
  .kpi-derivation {
    align-self: flex-start;
    font-size: var(--fs-xs);
    color: var(--brand);
    text-decoration: none;
  }
  .kpi-derivation:hover {
    text-decoration: underline;
  }

  /* Progress bar (UI-18 / Phase 40). 4 px track + brand fill, slim caption. */
  .kpi-progress-label {
    font-size: 11px;
    line-height: 1.2;
    color: var(--text-2);
    margin-top: 6px;
  }
  .kpi-progress-track {
    background: var(--sunk);
    border-radius: var(--r-control);
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
    background: var(--ok);
  }
</style>

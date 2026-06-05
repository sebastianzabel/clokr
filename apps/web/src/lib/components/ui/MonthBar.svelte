<script lang="ts">
  import type { Snippet } from "svelte";

  export type MonthBarStat = {
    label: string;
    value: string;
    unit?: string;
    /** Optional tone modifier — "pos" (good) or "neg" (bad). */
    tone?: "pos" | "neg";
  };

  interface Props {
    /** Optional serif italic eyebrow above the month label (e.g. "Buchungsmonat"). */
    eyebrow?: string;
    /** Cursor date — component derives "März 2026" label via Intl.DateTimeFormat('de-DE'). */
    date: Date;
    /** Mini-stat cluster rendered on the right side of the bar. */
    stats?: MonthBarStat[];
    /** Navigate to previous month. */
    onPrev: () => void;
    /** Navigate to next month. */
    onNext: () => void;
    /** Optional "Heute" jump — button only renders when provided. */
    onToday?: () => void;
    /** Optional extra trailing actions slot (e.g. PDF export button). */
    extraActions?: Snippet;
    /**
     * Test-id surface prefix (Phase 73-03, D-05). The primitive emits
     * `{prefix}`, `{prefix}-prev`, `{prefix}-next`, `{prefix}-today`,
     * `{prefix}-label`. Pages override per surface, e.g. "calendar-month-header"
     * on Zeiterfassung. Default keeps existing month-bar surface.
     */
    testIdPrefix?: string;
  }

  let {
    eyebrow,
    date,
    stats = [],
    onPrev,
    onNext,
    onToday,
    extraActions,
    testIdPrefix = "month-bar",
  }: Props = $props();

  const monthLabel = $derived(
    new Intl.DateTimeFormat("de-DE", { month: "long", year: "numeric" }).format(date),
  );
</script>

<!-- Month navigation bar primitive (D-02). Encapsulates the v1.5 .month-bar recipe.
     The primitive does NOT include `.card` because consumers typically wrap it
     in `<Card>` themselves (compositional). When used standalone, wrap in Card. -->
<div class="month-bar" data-testid={testIdPrefix}>
  <div class="month-bar-nav">
    <button
      class="nav-btn"
      onclick={onPrev}
      title="Vorheriger Monat"
      aria-label="Vorheriger Monat"
      data-testid={`${testIdPrefix}-prev`}
    >
      <svg
        width="18"
        height="18"
        viewBox="0 0 24 24"
        fill="none"
        stroke="currentColor"
        stroke-width="2.5"><polyline points="15 18 9 12 15 6" /></svg
      >
    </button>
    <div class="month-bar-center">
      {#if eyebrow}
        <div class="month-bar-eyebrow">{eyebrow}</div>
      {/if}
      <div class="month-bar-label" data-testid={`${testIdPrefix}-label`}>{monthLabel}</div>
    </div>
    <button
      class="nav-btn"
      onclick={onNext}
      title="Nächster Monat"
      aria-label="Nächster Monat"
      data-testid={`${testIdPrefix}-next`}
    >
      <svg
        width="18"
        height="18"
        viewBox="0 0 24 24"
        fill="none"
        stroke="currentColor"
        stroke-width="2.5"><polyline points="9 18 15 12 9 6" /></svg
      >
    </button>
    {#if onToday}
      <button
        class="btn btn-ghost btn-sm month-bar-today"
        onclick={onToday}
        data-testid={`${testIdPrefix}-today`}>Heute</button
      >
    {/if}
    {#if extraActions}
      <div class="month-bar-extra">{@render extraActions()}</div>
    {/if}
  </div>
  {#if stats.length}
    <div class="month-bar-stats">
      {#each stats as s (s.label)}
        <div class="mstat">
          <div class="mstat-label">{s.label}</div>
          <div class="mstat-value" class:pos={s.tone === "pos"} class:neg={s.tone === "neg"}>
            {s.value}{#if s.unit}<span class="mstat-unit">{s.unit}</span>{/if}
          </div>
        </div>
      {/each}
    </div>
  {/if}
</div>

<style>
  /* ── Combined Month-Bar (v1.5 — nav + mini-stats in one .card) ───── */
  .month-bar {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 16px;
    flex-wrap: nowrap;
  }

  .month-bar > .month-bar-nav {
    min-width: 0;
    flex: 0 1 auto;
  }

  .month-bar > .month-bar-stats {
    min-width: 0;
    flex: 0 0 auto;
  }

  /* Only allow wrap on truly narrow viewports (phone landscape). */
  @media (max-width: 640px) {
    .month-bar {
      flex-wrap: wrap;
    }
  }

  .month-bar-nav {
    display: flex;
    align-items: center;
    gap: 6px;
    flex-wrap: nowrap;
  }

  .month-bar-center {
    display: flex;
    flex-direction: column;
    align-items: center;
    min-width: 140px;
    text-align: center;
    position: relative;
  }

  .month-bar-eyebrow {
    font-family: var(--font-serif);
    font-style: italic;
    color: var(--brand-light, var(--brand));
    font-size: 13px;
    line-height: 1;
    margin-bottom: 4px;
  }

  .month-bar-label {
    font-family: var(--font-serif);
    font-weight: 400;
    font-size: 22px;
    line-height: 1.1;
    letter-spacing: 0.005em;
    color: var(--text);
    text-transform: capitalize;
    min-width: 9ch;
    text-align: center;
    white-space: nowrap;
  }

  .month-bar-today {
    margin-left: 4px;
  }

  .month-bar-extra {
    margin-left: auto;
    display: flex;
    gap: 8px;
    align-items: center;
  }

  /* ── Mini-stats cluster ──────────────────────────────────────────── */
  .month-bar-stats {
    display: flex;
    align-items: flex-end;
    gap: 14px;
    flex-wrap: nowrap;
  }

  .mstat {
    display: flex;
    flex-direction: column;
    gap: 4px;
    min-width: 0;
    white-space: nowrap;
  }

  .mstat-label {
    font-size: 10.5px;
    font-weight: 600;
    letter-spacing: 0.12em;
    text-transform: uppercase;
    color: var(--text-faint);
    white-space: nowrap;
  }

  .mstat-value {
    font-family: var(--font-serif);
    font-variant-numeric: tabular-nums;
    font-size: 19px;
    font-weight: 400;
    color: var(--text);
    line-height: 1;
    display: inline-flex;
    align-items: baseline;
    gap: 4px;
    white-space: nowrap;
  }

  .mstat-value.pos {
    color: var(--good);
  }

  .mstat-value.neg {
    color: var(--bad);
  }

  .mstat-unit {
    font-family: var(--font-sans);
    font-variant-numeric: normal;
    font-size: 12px;
    font-weight: 500;
    color: var(--text-muted);
  }
</style>

<script lang="ts">
  // Phase 76-02 — Pure-presentational calendar cell primitive (D-01 branches).
  //
  // Standalone component covering the calendar-cell-recipe states from
  // .planning/UI_STYLE_GUIDE.md (regular / holiday / absence / locked /
  // shift-overlap), plus the isLocked co-occurrence modifier.
  //
  // This component is intentionally NOT used by the existing route markup in
  // routes/(app)/time-entries/+page.svelte — that page uses the `cal-cell`
  // recipe with a different prop shape (status enum + arbzg badges + click-to-edit
  // button). See 76-02-SUMMARY.md for the architectural deviation notes.
  // The component exists primarily as a tested primitive that future route
  // refactors can adopt, and as the surface that 76-02's test suite covers.
  import Icon from "$components/Icon.svelte";

  export interface CalendarCellProps {
    date: Date;
    state: "regular" | "holiday" | "absence" | "locked" | "shift-overlap";
    workedMinutes?: number;
    targetMinutes?: number;
    holidayName?: string;
    absenceLabel?: string;
    isLocked?: boolean;
    overlapWith?: { startHHmm: string; endHHmm: string };
  }

  let {
    date,
    state,
    workedMinutes,
    targetMinutes,
    holidayName,
    absenceLabel,
    isLocked = false,
    overlapWith,
  }: CalendarCellProps = $props();

  // Build the class list deterministically. Primary state class + optional --locked modifier.
  // isLocked can co-occur with regular/holiday/absence — it adds the badge without replacing
  // the primary state class (D-01 co-occurrence branch).
  const classes = $derived.by(() => {
    const out = ["calendar-cell"];
    if (state === "holiday") out.push("calendar-cell--holiday");
    if (state === "absence") out.push("calendar-cell--absence");
    if (state === "locked") out.push("calendar-cell--locked");
    if (state === "shift-overlap") out.push("calendar-cell--overlap");
    if (isLocked && state !== "locked") out.push("calendar-cell--locked");
    return out.join(" ");
  });

  const delta = $derived(
    workedMinutes !== undefined && targetMinutes !== undefined
      ? workedMinutes - targetMinutes
      : null,
  );

  function fmtMinutes(m: number): string {
    // U+2212 minus sign for negative deltas (matches Saldo formatter and v1.5 type recipe)
    const sign = m >= 0 ? "+" : "−";
    const abs = Math.abs(m);
    const h = Math.floor(abs / 60);
    const min = abs % 60;
    return `${sign}${h}:${String(min).padStart(2, "0")}`;
  }

  const isoDate = $derived(date.toISOString().slice(0, 10));
</script>

<div class={classes} data-testid="calendar-cell" data-date={isoDate}>
  <div class="calendar-cell__date">{date.getDate()}</div>

  {#if state === "holiday" && holidayName}
    <div class="calendar-cell__label" data-testid="cell-holiday-name">{holidayName}</div>
  {/if}

  {#if state === "absence" && absenceLabel}
    <div class="calendar-cell__label" data-testid="cell-absence-label">{absenceLabel}</div>
  {/if}

  {#if state === "shift-overlap" && overlapWith}
    <div class="calendar-cell__overlap" data-testid="cell-overlap-times">
      {overlapWith.startHHmm}–{overlapWith.endHHmm}
    </div>
  {/if}

  {#if isLocked || state === "locked"}
    <div class="calendar-cell__lock" data-testid="cell-lock-badge" aria-label="gesperrt">
      <Icon name="lock" />
    </div>
  {/if}

  {#if delta !== null && state === "regular"}
    <div
      class="calendar-cell__delta"
      class:calendar-cell__delta--positive={delta > 0}
      class:calendar-cell__delta--negative={delta < 0}
      data-testid="cell-delta"
    >
      {fmtMinutes(delta)}
    </div>
  {/if}
</div>

<style>
  /* Internal element layout only — no token overrides per UI_STYLE_GUIDE.
     Semantic colour tokens use the v1.5 namespace (--good/--bad/--warn), NOT
     the non-existent --success/--danger/--warning the plan scaffold suggested.
     The .calendar-cell-recipe global styles (background / border / hover) are
     intentionally out of scope here — tests assert classes + text only. */
  .calendar-cell {
    position: relative;
  }
  .calendar-cell__date {
    font-weight: 600;
    font-size: 0.875rem;
  }
  .calendar-cell__label {
    font-size: 0.75rem;
    color: var(--text-muted);
  }
  .calendar-cell__delta {
    font-size: 0.75rem;
    font-variant-numeric: tabular-nums;
  }
  .calendar-cell__delta--positive {
    color: var(--good);
  }
  .calendar-cell__delta--negative {
    color: var(--bad);
  }
  .calendar-cell__lock {
    position: absolute;
    top: 4px;
    right: 4px;
    opacity: 0.6;
  }
  .calendar-cell__overlap {
    font-size: 0.75rem;
    color: var(--warn);
  }
</style>

<script lang="ts">
  /**
   * AbsenceTimeline — Issue #840 (D-840-07/10).
   *
   * The one person-by-day timeline of the team leave area: one row per person, one column per day
   * of the period. Tracer subset of plan 840-02 (day columns, bars, the four bar styles);
   * 840-05 completes it (lanes of the planner, interaction, today marker).
   *
   * Four bar styles, each readable without colour alone (WCAG 1.4.1): `gesetzt` solid,
   * `beantragt` dashed border on a light tint, `wunsch` the brand outline, `abwesend` solid
   * neutral — a masked bar has no type and reads „abwesend“.
   *
   * The component draws what it is given and decides nothing about visibility. It renders no
   * dialog (#570: an animated Section traps fixed dialogs) and imports neither the auth store nor
   * the API client, so it stays mountable in vitest.
   */
  import { onMount } from "svelte";
  import { ABSENT, WISH, leaveTypeColor } from "$lib/leave/leave-colors";
  import {
    dayColumns,
    type Period,
    type TimelineBar,
    type TimelinePerson,
  } from "$lib/leave/timeline-model";
  import { assignLanes, dayIndex, monthSegments } from "$lib/leave-plan/timeline";

  interface Props {
    rows: TimelinePerson[];
    period: Period;
    holidays?: Array<{ day: string; name: string }>;
    /** Measured from the grid when absent; tests pass it. */
    columnWidthPx?: number;
  }

  let { rows, period, holidays = [], columnWidthPx }: Props = $props();

  const NAME_WIDTH = 160;
  const LANE_HEIGHT = 24;
  /** A text label on a bar needs room for a word (D-840-10). */
  const LABEL_MIN_WIDTH = 56;
  /** Header day cells print letter and number from this column width on. */
  const DAY_TEXT_MIN_WIDTH = 14;
  const FALLBACK_WIDTH: Record<Period["zoom"], number> = { jahr: 4, quartal: 12, monat: 28 };
  const MIN_WIDTH: Record<Period["zoom"], number> = { jahr: 4, quartal: 10, monat: 24 };

  // Measured on mount and on resize. A guarded ResizeObserver: jsdom has none, and a width of 0
  // there falls back to a fixed column width.
  let rootEl: HTMLDivElement | undefined = $state();
  let measuredWidth = $state(0);

  onMount(() => {
    const el = rootEl;
    if (!el) return;
    measuredWidth = el.clientWidth;
    if (typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(() => (measuredWidth = el.clientWidth));
    observer.observe(el);
    return () => observer.disconnect();
  });

  const columns = $derived(dayColumns(period));
  const startIndex = $derived(dayIndex(period.year, period.startDay));
  const columnWidth = $derived.by(() => {
    if (columnWidthPx !== undefined) return columnWidthPx;
    if (measuredWidth <= 0) return FALLBACK_WIDTH[period.zoom];
    return Math.max(MIN_WIDTH[period.zoom], (measuredWidth - NAME_WIDTH) / columns.length);
  });
  const trackWidth = $derived(columns.length * columnWidth);
  const showDayText = $derived(columnWidth >= DAY_TEXT_MIN_WIDTH);

  const holidayName = $derived(new Map(holidays.map((h) => [h.day, h.name])));

  const months = $derived(
    monthSegments(period.year)
      .map((segment) => {
        const first = Math.max(segment.startIndex, startIndex);
        const last = Math.min(
          segment.startIndex + segment.length - 1,
          startIndex + columns.length - 1,
        );
        return { ...segment, left: (first - startIndex) * columnWidth, count: last - first + 1 };
      })
      .filter((segment) => segment.count > 0),
  );

  /** Runs of weekend days (Saturday and Sunday are one run), shaded behind the bars. */
  const weekendRuns = $derived.by(() => {
    const runs: Array<{ left: number; width: number }> = [];
    columns.forEach((column, i) => {
      if (!column.isWeekend) return;
      const previous = runs[runs.length - 1];
      if (previous && previous.left + previous.width === i * columnWidth) {
        previous.width += columnWidth;
      } else {
        runs.push({ left: i * columnWidth, width: columnWidth });
      }
    });
    return runs;
  });

  const holidayCells = $derived(
    columns.flatMap((column, i) =>
      holidayName.has(column.day)
        ? [{ day: column.day, name: holidayName.get(column.day) ?? "", left: i * columnWidth }]
        : [],
    ),
  );

  interface PlacedBar {
    bar: TimelineBar;
    left: number;
    width: number;
    lane: number;
  }

  /** Bars of one person clipped to the period, packed into lanes so none overlaps another. */
  function layoutOf(person: TimelinePerson): { bars: PlacedBar[]; lanes: number } {
    const last = columns.length - 1;
    const visible = person.bars.flatMap((bar) => {
      const from = dayIndex(period.year, bar.start) - startIndex;
      const to = dayIndex(period.year, bar.end) - startIndex;
      if (to < 0 || from > last) return [];
      return [{ bar, start: Math.max(from, 0), end: Math.min(to, last) }];
    });
    const lanes = assignLanes(visible);
    return {
      bars: visible.map((item, i) => ({
        bar: item.bar,
        left: item.start * columnWidth,
        width: (item.end - item.start + 1) * columnWidth,
        lane: lanes[i],
      })),
      lanes: Math.max(1, ...lanes.map((lane) => lane + 1)),
    };
  }

  const layouts = $derived(new Map(rows.map((person) => [person.employeeId, layoutOf(person)])));

  function fmtDate(iso: string): string {
    const [y, m, d] = iso.split("-");
    return `${d}.${m}.${y}`;
  }

  function barColor(bar: TimelineBar) {
    if (bar.style === "abwesend") return ABSENT;
    if (bar.style === "wunsch") return WISH;
    return leaveTypeColor(bar.typeCode);
  }

  /** Label, state and dates: the text of `title` and, with the person, of `aria-label`. */
  function barTitle(bar: TimelineBar): string {
    const state =
      bar.style === "beantragt" ? ", beantragt" : bar.style === "wunsch" ? ", Wunsch" : "";
    const half = bar.halfDay ? ", halber Tag" : "";
    const range =
      bar.start === bar.end ? fmtDate(bar.start) : `${fmtDate(bar.start)} bis ${fmtDate(bar.end)}`;
    return `${bar.label}${state}: ${range}${half}`;
  }
</script>

<div
  class="absence-timeline"
  data-testid="absence-timeline"
  bind:this={rootEl}
  style:--tl-name-w="{NAME_WIDTH}px"
  style:--tl-col-w="{columnWidth}px"
>
  <div class="tl-scroll">
    <div class="tl-inner" style:min-width="{NAME_WIDTH + trackWidth}px">
      <!-- Header: month names, then weekday letter and day number -->
      <div class="tl-line tl-head">
        <div class="tl-name tl-name--head"></div>
        <div class="tl-track tl-track--head" style:width="{trackWidth}px">
          {#each months as month (month.month)}
            <div
              class="tl-month"
              data-testid="absence-month-{month.month}"
              style:left="{month.left}px"
              style:width="{month.count * columnWidth}px"
            >
              {month.label}
            </div>
          {/each}
          {#each columns as column, i (column.day)}
            {@const holiday = holidayName.get(column.day)}
            <div
              class="absence-day"
              class:absence-day--weekend={column.isWeekend}
              class:absence-day--holiday={holiday !== undefined}
              data-testid="absence-day-{column.day}"
              style:left="{i * columnWidth}px"
              style:width="{columnWidth}px"
              title={holiday}
            >
              {#if showDayText}
                <span class="absence-day-letter">{column.weekdayLetter}</span>
                <span class="absence-day-number">{column.dayNumber}</span>
              {/if}
            </div>
          {/each}
        </div>
      </div>

      <!-- One row per person -->
      {#each rows as person (person.employeeId)}
        {@const layout = layouts.get(person.employeeId) ?? { bars: [], lanes: 1 }}
        <div class="tl-line tl-person" data-testid="absence-row-{person.employeeId}">
          <div class="tl-name" title={person.name}>{person.name}</div>
          <div
            class="tl-track"
            data-testid="plan-track-{person.employeeId}"
            style:width="{trackWidth}px"
            style:height="{layout.lanes * LANE_HEIGHT + 8}px"
          >
            {#each weekendRuns as run (run.left)}
              <div class="tl-weekend" style:left="{run.left}px" style:width="{run.width}px"></div>
            {/each}
            {#each holidayCells as holiday (holiday.day)}
              <div
                class="tl-holiday"
                style:left="{holiday.left}px"
                style:width="{columnWidth}px"
                title={holiday.name}
              ></div>
            {/each}
            {#each layout.bars as placed (placed.bar.key)}
              {@const bar = placed.bar}
              {@const color = barColor(bar)}
              <button
                type="button"
                class="absence-bar absence-bar--{bar.style}"
                data-testid="absence-bar-{bar.key}"
                data-bar-style={bar.style}
                style:left="{placed.left}px"
                style:width="{placed.width}px"
                style:top="{4 + placed.lane * LANE_HEIGHT}px"
                style:--bar-fill="var({color.fill})"
                style:--bar-text="var({color.text})"
                title={barTitle(bar)}
                aria-label="{person.name}: {barTitle(bar)}"
              >
                {#if placed.width >= LABEL_MIN_WIDTH}{bar.label}{/if}
              </button>
            {/each}
          </div>
        </div>
      {/each}
    </div>
  </div>
</div>

<style>
  .absence-timeline {
    width: 100%;
    background: var(--bg-card);
    border: 1px solid var(--border);
    border-radius: var(--r-md);
  }

  .tl-scroll {
    overflow-x: auto;
  }

  .tl-inner {
    position: relative;
  }

  .tl-line {
    display: flex;
    align-items: stretch;
    border-bottom: 1px solid var(--border);
  }

  .tl-line:last-child {
    border-bottom: none;
  }

  .tl-name {
    position: sticky;
    left: 0;
    z-index: 3;
    flex: none;
    width: var(--tl-name-w);
    padding: 0.35rem 0.75rem;
    background: var(--bg-card);
    border-right: 1px solid var(--border);
    font-size: 0.875rem;
    color: var(--text);
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
    display: flex;
    align-items: center;
  }

  .tl-track {
    position: relative;
    flex: none;
    min-height: 28px;
    background-image: repeating-linear-gradient(
      to right,
      transparent 0,
      transparent calc(var(--tl-col-w) - 1px),
      var(--border) calc(var(--tl-col-w) - 1px),
      var(--border) var(--tl-col-w)
    );
    background-size: 100% 100%;
  }

  .tl-track--head {
    height: 52px;
    background-image: none;
  }

  .tl-month {
    position: absolute;
    top: 0;
    height: 22px;
    padding: 0 0.5rem;
    font-size: 0.8125rem;
    font-weight: 500;
    color: var(--text);
    border-left: 1px solid var(--border);
    overflow: hidden;
    white-space: nowrap;
    line-height: 22px;
  }

  .absence-day {
    position: absolute;
    top: 22px;
    height: 30px;
    display: flex;
    flex-direction: column;
    align-items: center;
    justify-content: center;
    font-size: 0.6875rem;
    line-height: 1.1;
    color: var(--text-muted);
  }

  .absence-day--weekend {
    background: var(--bg-subtle);
  }

  .absence-day--holiday {
    background: var(--warn-soft);
    color: var(--text);
  }

  .absence-day-number {
    font-variant-numeric: tabular-nums;
  }

  .tl-weekend {
    position: absolute;
    top: 0;
    bottom: 0;
    background: var(--bg-subtle);
    opacity: 0.8;
    pointer-events: none;
  }

  .tl-holiday {
    position: absolute;
    top: 0;
    bottom: 0;
    background: var(--warn-soft);
  }

  .absence-bar {
    position: absolute;
    height: 20px;
    box-sizing: border-box;
    margin: 0;
    border-radius: var(--r-sm);
    font: inherit;
    font-size: 0.75rem;
    line-height: 16px;
    padding: 0 0.35rem;
    overflow: hidden;
    white-space: nowrap;
    text-align: left;
    cursor: default;
  }

  .absence-bar:focus-visible {
    outline: 2px solid var(--brand);
    outline-offset: 1px;
  }

  /* Set: solid fill in the type colour. */
  .absence-bar--gesetzt {
    background: var(--bar-fill);
    border: 2px solid var(--bar-fill);
    color: var(--bar-text);
  }

  /* Requested: dashed 2 px border in the type colour on a light tint. */
  .absence-bar--beantragt {
    background: color-mix(in srgb, var(--bar-fill) 18%, transparent);
    border: 2px dashed var(--bar-fill);
    color: var(--text);
  }

  /* Wish: the brand outline on a soft brand fill. */
  .absence-bar--wunsch {
    background: var(--brand-soft);
    border: 2px solid var(--brand);
    color: var(--text);
  }

  /* Absent: solid neutral — the reader may not learn the type. */
  .absence-bar--abwesend {
    background: var(--bar-fill);
    border: 2px solid var(--bar-fill);
    color: var(--bar-text);
  }
</style>

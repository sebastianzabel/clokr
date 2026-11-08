<script lang="ts">
  /**
   * AbsenceTimeline — Issue #840 (D-840-07..10, E-06).
   *
   * The one person-by-day timeline of the absence area: one row per person, three zooms.
   *
   * - Jahr: a grid of ISO weeks (53 columns, 54 in 2040), the width fitted so it never scrolls
   *   sideways at desktop width; a week cell is filled by the share of the person's absent Werktage.
   * - Quartal: day columns, at least 10 px wide; narrower windows scroll with a fade and a hint.
   * - Monat: day columns, at least 28 px wide.
   *
   * Bar styles, each readable without colour alone (WCAG 1.4.1): `gesetzt` solid, `beantragt`
   * dashed border on a light tint, `wunsch` diagonal brand stripes with an outline, `abwesend`
   * solid neutral — a masked bar has no type and reads „abwesend“.
   *
   * Editable wishes move and resize by pointer in Quartal and Monat only; a finished drag calls
   * `onMoveWish` once and the parent saves and reloads — the server stays authoritative. Enter on a
   * wish opens the edit callback, the keyboard alternative to dragging.
   *
   * The component draws what it is given and decides nothing about visibility. It writes nothing,
   * renders no dialog (#570: an animated Section traps fixed dialogs) and imports neither the auth
   * store nor the API client, so it stays mountable in vitest.
   */
  import { onMount } from "svelte";
  import { ABSENT, leaveTypeColor } from "$lib/leave/leave-colors";
  import {
    dayColumns,
    dayMarkings,
    isoWeekColumns,
    weekCells,
    workdaySet,
    type Period,
    type TimelineBar,
    type TimelinePerson,
  } from "$lib/leave/timeline-model";
  import { LEAVE_TYPES } from "$lib/leave/team-calendar-visibility";
  import { MONTH_NAMES_DE } from "$lib/reports/period-state";
  import {
    assignLanes,
    dayIndex,
    monthSegments,
    moveRange,
    pointerDeltaToDays,
    resizeRange,
  } from "$lib/leave-plan/timeline";
  import { FORECAST_WARNING, forecastLabel } from "$lib/leave-plan/labels";
  import type { DayRange } from "$lib/leave-plan/types";

  interface Props {
    rows: TimelinePerson[];
    period: Period;
    holidays?: Array<{ day: string; name: string }>;
    /** Closed weekdays (Monday = 0) of the one salon in view; `null` = no single salon. */
    closedWeekdays?: ReadonlySet<number> | null;
    /** Tenant-local today, `YYYY-MM-DD`; the component reads no clock. */
    today: string;
    /** `exceeded` maps a key (day or Monday) to its tooltip. */
    load?: {
      kind: "day" | "week";
      counts: Map<string, number>;
      exceeded?: Map<string, string>;
      hint?: string;
    };
    onWeekSelect?: (monday: string) => void;
    onMoveWish?: (bar: TimelineBar, range: DayRange) => void | Promise<void>;
    onEditWish?: (bar: TimelineBar) => void;
    onAddWish?: (employeeId: string, day: string) => void;
    onBarSelect?: (bar: TimelineBar) => void;
    /** Whether a click on an empty day of this person's row may start a wish. Default: yes. */
    canAddWishFor?: (employeeId: string) => boolean;
    showForecast?: boolean;
    /** Injected column width; measured from the grid when absent. Tests pass it. */
    columnWidthPx?: number;
    /** Injected container width; measured when absent. Tests pass it. */
    widthPx?: number;
  }

  let {
    rows,
    period,
    holidays = [],
    closedWeekdays = null,
    today,
    load,
    onWeekSelect,
    onMoveWish,
    onEditWish,
    onAddWish,
    onBarSelect,
    canAddWishFor = () => true,
    showForecast = false,
    columnWidthPx,
    widthPx,
  }: Props = $props();

  const NAME_WIDTH = 160;
  const FORECAST_WIDTH = 184;
  const LANE_HEIGHT = 24;
  /** A text label on a bar needs room for a word (D-840-10). */
  const LABEL_MIN_WIDTH = 56;
  /** Header cells print letter and number from this column width on. */
  const DAY_TEXT_MIN_WIDTH = 14;
  /** Container width assumed while nothing is measured (jsdom, first paint). */
  const FALLBACK_CONTAINER = 1144;
  const MIN_WIDTH: Record<Period["zoom"], number> = { jahr: 4, quartal: 10, monat: 28 };

  // Measured on mount and on resize. A guarded ResizeObserver: jsdom has none.
  let rootEl: HTMLDivElement | undefined = $state();
  let scrollEl: HTMLDivElement | undefined = $state();
  let measuredWidth = $state(0);
  let scrolledToEnd = $state(false);

  onMount(() => {
    const el = rootEl;
    if (!el) return;
    measuredWidth = el.clientWidth;
    if (typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(() => (measuredWidth = el.clientWidth));
    observer.observe(el);
    return () => observer.disconnect();
  });

  function onScroll() {
    if (!scrollEl) return;
    scrolledToEnd = scrollEl.scrollLeft + scrollEl.clientWidth >= scrollEl.scrollWidth - 1;
  }

  const isYear = $derived(period.zoom === "jahr");
  const weeks = $derived(isYear ? isoWeekColumns(period.year) : []);
  const columns = $derived(isYear ? [] : dayColumns(period));
  const count = $derived(isYear ? weeks.length : columns.length);
  const startIndex = $derived(dayIndex(period.year, period.startDay));

  const containerWidth = $derived(
    widthPx ?? (measuredWidth > 0 ? measuredWidth : FALLBACK_CONTAINER),
  );
  const sideWidth = $derived(NAME_WIDTH + (showForecast ? FORECAST_WIDTH : 0));
  const columnWidth = $derived.by(() => {
    if (columnWidthPx !== undefined) return columnWidthPx;
    return Math.max(MIN_WIDTH[period.zoom], (containerWidth - sideWidth) / count);
  });
  const trackWidth = $derived(count * columnWidth);
  const totalWidth = $derived(sideWidth + trackWidth);
  const overflowing = $derived(totalWidth > containerWidth + 1);
  const showMoreHint = $derived(overflowing && !scrolledToEnd);
  const showDayText = $derived(columnWidth >= DAY_TEXT_MIN_WIDTH);

  const holidayName = $derived(new Map(holidays.map((h) => [h.day, h.name])));
  const markings = $derived(dayMarkings(period, { holidays, closedWeekdays, today }));
  const workdays = $derived(workdaySet(closedWeekdays));

  // ── Formatting ───────────────────────────────────────────────────────────────────────────────

  function fmtDate(iso: string): string {
    const [y, m, d] = iso.split("-");
    return `${d}.${m}.${y}`;
  }

  function fmtShort(iso: string): string {
    const [, m, d] = iso.split("-");
    return `${d}.${m}.`;
  }

  // ── Header: months ───────────────────────────────────────────────────────────────────────────

  const months = $derived.by(() => {
    if (isYear) {
      const starts = MONTH_NAMES_DE.map((_, month) => {
        const first = `${String(period.year).padStart(4, "0")}-${String(month + 1).padStart(2, "0")}-01`;
        return weeks.findIndex((w) => w.monday <= first && first <= w.sunday);
      });
      return MONTH_NAMES_DE.map((label, month) => {
        const from = starts[month];
        const to = month === 11 ? weeks.length : starts[month + 1];
        return { month, label, left: from * columnWidth, width: (to - from) * columnWidth };
      });
    }
    return monthSegments(period.year)
      .map((segment) => {
        const first = Math.max(segment.startIndex, startIndex);
        const last = Math.min(segment.startIndex + segment.length - 1, startIndex + count - 1);
        return {
          month: segment.month,
          label: segment.label,
          left: (first - startIndex) * columnWidth,
          width: (last - first + 1) * columnWidth,
          visible: last - first + 1,
        };
      })
      .filter((segment) => segment.visible > 0);
  });

  /** Quartal and Monat scroll when narrow, so their month labels stay put under the name column. */
  const stickyMonths = $derived(!isYear);

  // ── Day-level backdrops (Quartal, Monat) ─────────────────────────────────────────────────────

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
      holidayName.has(column.day) ? [{ day: column.day, left: i * columnWidth }] : [],
    ),
  );

  const closedCells = $derived(
    columns.flatMap((column, i) =>
      markings.get(column.day)?.closed ? [{ day: column.day, left: i * columnWidth }] : [],
    ),
  );

  const todayLeft = $derived.by(() => {
    const index = columns.findIndex((column) => column.day === today);
    return index < 0 ? null : index * columnWidth;
  });

  function isMonday(day: string): boolean {
    const [y, m, d] = day.split("-").map(Number);
    return new Date(Date.UTC(y, m - 1, d)).getUTCDay() === 1;
  }

  /** Weekday letter and number for a header cell; narrow columns print only Monday's number. */
  function dayHeadText(column: { day: string; weekdayLetter: string; dayNumber: number }) {
    if (showDayText) return { letter: column.weekdayLetter, number: String(column.dayNumber) };
    return { letter: "", number: isMonday(column.day) ? String(column.dayNumber) : "" };
  }

  function dayHeadTitle(day: string): string | undefined {
    return holidayName.get(day);
  }

  function dayHeadLabel(day: string): string | undefined {
    const name = holidayName.get(day);
    return name === undefined ? undefined : `Feiertag: ${name}, ${fmtDate(day)}`;
  }

  // ── Jahr: week cells ─────────────────────────────────────────────────────────────────────────

  const cellsByPerson = $derived(
    isYear
      ? new Map(
          rows.map((person) => [
            person.employeeId,
            weekCells(person, period.year, workdays, holidays),
          ]),
        )
      : new Map<string, ReturnType<typeof weekCells>>(),
  );

  const weekIndex = $derived(new Map(weeks.map((week, i) => [week.monday, i])));
  const todayWeek = $derived(weeks.find((w) => w.monday <= today && today <= w.sunday)?.monday);

  function cellColor(cell: { fill: "type" | "absent" | null; typeCode: string | null }) {
    return cell.fill === "type" ? leaveTypeColor(cell.typeCode) : ABSENT;
  }

  function typeLabelOf(code: string | null): string | null {
    if (code === null) return null;
    return LEAVE_TYPES.find((t) => t.code === code)?.label ?? null;
  }

  /** „KW 45, 02.11. bis 08.11.2026: 83 % der Werktage abwesend (Urlaub), beantragt“. */
  function weekLabel(
    week: { isoWeek: number; monday: string; sunday: string },
    cell: {
      share: number;
      fill: "type" | "absent" | null;
      typeCode: string | null;
      hasBeantragt: boolean;
      hasWish: boolean;
    },
  ): string {
    const range = `${fmtShort(week.monday)} bis ${fmtDate(week.sunday)}`;
    const state: string[] = [];
    if (cell.share > 0) {
      const type = cell.fill === "type" ? typeLabelOf(cell.typeCode) : null;
      state.push(
        `${Math.round(cell.share * 100)} % der Werktage abwesend${type ? ` (${type})` : ""}`,
      );
    } else {
      state.push("keine Abwesenheit");
    }
    if (cell.hasBeantragt) state.push("beantragt");
    if (cell.hasWish) state.push("Wunsch");
    return `KW ${week.isoWeek}, ${range}: ${state.join(", ")}`;
  }

  function onWeekKeydown(event: KeyboardEvent, monday: string) {
    if (event.key !== "Enter") return;
    event.preventDefault();
    onWeekSelect?.(monday);
  }

  // ── Load row ─────────────────────────────────────────────────────────────────────────────────

  const loadCells = $derived.by(() => {
    if (!load) return [];
    const wanted = isYear ? "week" : "day";
    if (load.kind !== wanted) return [];
    return [...load.counts.entries()].flatMap(([key, value]) => {
      const index = isYear ? (weekIndex.get(key) ?? -1) : dayIndex(period.year, key) - startIndex;
      if (index < 0 || index >= count) return [];
      const tooltip = load.exceeded?.get(key);
      return [{ key, count: value, index, exceeded: tooltip !== undefined, tooltip }];
    });
  });
  const maxLoad = $derived(Math.max(1, ...loadCells.map((cell) => cell.count)));

  function loadLabel(cell: { key: string; count: number; exceeded: boolean; tooltip?: string }) {
    const when = isYear ? `Woche ab ${fmtDate(cell.key)}` : fmtDate(cell.key);
    const limit = cell.exceeded
      ? `, Grenze überschritten${cell.tooltip ? ` – ${cell.tooltip}` : ""}`
      : "";
    return `${when}: ${cell.count} Personen abwesend${limit}`;
  }

  // ── Bars (Quartal, Monat) ────────────────────────────────────────────────────────────────────

  type DragMode = "move" | "start" | "end";
  let drag = $state<{
    key: string;
    mode: DragMode;
    startX: number;
    delta: number;
    base: DayRange;
  } | null>(null);
  let suppressClick = false;

  function previewRange(bar: TimelineBar): DayRange {
    const base: DayRange = { startDate: bar.start, endDate: bar.end };
    if (!drag || drag.key !== bar.key) return base;
    if (drag.mode === "move") return moveRange(drag.base, drag.delta, period.year);
    return resizeRange(drag.base, drag.mode, drag.delta, period.year);
  }

  interface PlacedBar {
    bar: TimelineBar;
    left: number;
    width: number;
    lane: number;
  }

  /** Bars of one person clipped to the period, packed into lanes so none overlaps another. */
  function layoutOf(person: TimelinePerson): { bars: PlacedBar[]; lanes: number } {
    const last = count - 1;
    const visible = person.bars.flatMap((bar) => {
      const range = previewRange(bar);
      const from = dayIndex(period.year, range.startDate) - startIndex;
      const to = dayIndex(period.year, range.endDate) - startIndex;
      // The bar being dragged stays in the grid (pinned to the edge) even when the preview leaves
      // the period: a removed element would lose the captured pointer and the drop.
      if ((to < 0 || from > last) && drag?.key !== bar.key) return [];
      const start = Math.min(Math.max(from, 0), last);
      return [{ bar, start, end: Math.max(start, Math.min(to, last)) }];
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

  const layouts = $derived(
    isYear
      ? new Map<string, ReturnType<typeof layoutOf>>()
      : new Map(rows.map((person) => [person.employeeId, layoutOf(person)])),
  );

  function barColor(bar: TimelineBar) {
    if (bar.style === "abwesend") return ABSENT;
    return leaveTypeColor(bar.typeCode);
  }

  /** Label, state and dates: the text of `title` and, with the person, of `aria-label`. */
  function barTitle(bar: TimelineBar): string {
    const state = bar.style === "beantragt" ? ", beantragt" : "";
    const half = bar.halfDay ? ", halber Tag" : "";
    const range =
      bar.start === bar.end ? fmtDate(bar.start) : `${fmtDate(bar.start)} bis ${fmtDate(bar.end)}`;
    const hint = bar.hint ? `. ${bar.hint}` : "";
    return `${bar.label}${state}: ${range}${half}${hint}`;
  }

  function wishAriaLabel(person: TimelinePerson, bar: TimelineBar): string {
    const suffix = bar.editable ? ". Mit Enter bearbeiten." : ".";
    return `${person.name}: ${barTitle(bar)}${suffix}`;
  }

  function onBarKeydown(event: KeyboardEvent, bar: TimelineBar) {
    if (event.key !== "Enter") return;
    event.preventDefault();
    onBarSelect?.(bar);
  }

  // ── Wishes: drag, resize, edit ───────────────────────────────────────────────────────────────

  function beginDrag(event: PointerEvent, bar: TimelineBar, mode: DragMode) {
    if (!bar.editable || event.button !== 0) return;
    event.stopPropagation();
    const target = event.currentTarget as HTMLElement;
    if (typeof target.setPointerCapture === "function") target.setPointerCapture(event.pointerId);
    drag = {
      key: bar.key,
      mode,
      startX: event.clientX,
      delta: 0,
      base: { startDate: bar.start, endDate: bar.end },
    };
  }

  function moveDrag(event: PointerEvent, bar: TimelineBar) {
    if (!drag || drag.key !== bar.key) return;
    drag.delta = pointerDeltaToDays(event.clientX - drag.startX, columnWidth);
  }

  function endDrag(event: PointerEvent, bar: TimelineBar) {
    if (!drag || drag.key !== bar.key) return;
    const finished = drag;
    drag = null;
    const delta = pointerDeltaToDays(event.clientX - finished.startX, columnWidth);
    if (delta === 0) return;
    suppressClick = true;
    setTimeout(() => (suppressClick = false), 0);
    const range =
      finished.mode === "move"
        ? moveRange(finished.base, delta, period.year)
        : resizeRange(finished.base, finished.mode, delta, period.year);
    if (range.startDate === finished.base.startDate && range.endDate === finished.base.endDate) {
      return;
    }
    void onMoveWish?.(bar, range);
  }

  function cancelDrag() {
    drag = null;
  }

  function onWishClick(event: MouseEvent, bar: TimelineBar) {
    event.stopPropagation();
    if (suppressClick) {
      suppressClick = false;
      return;
    }
    onEditWish?.(bar);
  }

  function onWishKeydown(event: KeyboardEvent, bar: TimelineBar) {
    if (event.key !== "Enter") return;
    event.preventDefault();
    onEditWish?.(bar);
  }

  // ── Adding a wish ────────────────────────────────────────────────────────────────────────────

  function isOutside(person: TimelinePerson, day: string): boolean {
    return (person.outsideRanges ?? []).some((range) => day >= range.start && day <= range.end);
  }

  function onTrackClick(event: MouseEvent, person: TimelinePerson) {
    if (!onAddWish || event.target !== event.currentTarget) return;
    if (!canAddWishFor(person.employeeId)) return;
    const rect = (event.currentTarget as HTMLElement).getBoundingClientRect();
    const column = Math.floor((event.clientX - rect.left) / columnWidth);
    if (column < 0 || column >= columns.length) return;
    const day = columns[column].day;
    if (isOutside(person, day)) return;
    onAddWish(person.employeeId, day);
  }
</script>

<div
  class="absence-timeline"
  class:absence-timeline--overflow={overflowing}
  data-testid="absence-timeline"
  data-zoom={period.zoom}
  bind:this={rootEl}
  style:--tl-name-w="{NAME_WIDTH}px"
  style:--tl-forecast-w="{FORECAST_WIDTH}px"
  style:--tl-col-w="{columnWidth}px"
>
  <div class="tl-scroll" bind:this={scrollEl} onscroll={onScroll}>
    <div class="tl-inner" style:min-width="{totalWidth}px">
      <!-- Header: month names, then weeks (Jahr) or weekday letter and day number -->
      <div class="tl-line tl-head">
        <div class="tl-name tl-name--head"></div>
        <div class="tl-track tl-track--head" style:width="{trackWidth}px">
          {#each months as month (month.month)}
            <div
              class="tl-month"
              class:tl-month--sticky={stickyMonths}
              data-testid="absence-month-{month.month}"
              style:left="{month.left}px"
              style:width="{month.width}px"
            >
              <span class="tl-month-label">{month.label}</span>
            </div>
          {/each}
          {#if isYear}
            {#each weeks as week, i (week.monday)}
              <div
                class="tl-weekhead"
                class:tl-weekhead--today={week.monday === todayWeek}
                data-testid="week-head-{week.monday}"
                style:left="{i * columnWidth}px"
                style:width="{columnWidth}px"
                title="KW {week.isoWeek}: {fmtShort(week.monday)} bis {fmtDate(week.sunday)}"
              >
                {#if showDayText}{week.isoWeek}{/if}
              </div>
            {/each}
          {:else}
            {#each columns as column, i (column.day)}
              {@const mark = markings.get(column.day)}
              {@const holiday = dayHeadTitle(column.day)}
              {@const text = dayHeadText(column)}
              <svelte:element
                this={holiday === undefined ? "div" : "button"}
                type={holiday === undefined ? undefined : "button"}
                class="absence-day"
                class:absence-day--weekend={column.isWeekend}
                class:absence-day--holiday={holiday !== undefined}
                class:absence-day--closed={mark?.closed}
                class:absence-day--today={mark?.today}
                data-testid="absence-day-{column.day}"
                style:left="{i * columnWidth}px"
                style:width="{columnWidth}px"
                title={holiday}
                aria-label={dayHeadLabel(column.day)}
              >
                <span class="absence-day-letter">{text.letter}</span>
                <span class="absence-day-number">{text.number}</span>
              </svelte:element>
            {/each}
          {/if}
        </div>
        {#if showForecast}<div class="tl-forecast tl-forecast--head">Anspruch</div>{/if}
      </div>

      <!-- Load: how many persons are absent per day (Quartal, Monat) or per week (Jahr) -->
      {#if load}
        <div class="tl-line tl-load" data-testid="plan-day-load">
          <div class="tl-name" title={load.hint}>Abwesend (Personen)</div>
          <div class="tl-track" style:width="{trackWidth}px" style:height="28px">
            {#each loadCells as cell (cell.key)}
              <div
                class="tl-load-cell"
                class:tl-load-cell--exceeded={cell.exceeded}
                data-testid="day-load-{cell.key}"
                data-exceeded={cell.exceeded ? "true" : "false"}
                style:left="{cell.index * columnWidth}px"
                style:width="{columnWidth}px"
                style:--tl-load-share="{Math.round((cell.count / maxLoad) * 60) + 15}%"
                title={loadLabel(cell)}
                aria-label={loadLabel(cell)}
                role="img"
              >
                {#if columnWidth >= DAY_TEXT_MIN_WIDTH}{cell.count}{/if}
              </div>
            {/each}
          </div>
          {#if showForecast}<div class="tl-forecast"></div>{/if}
        </div>
      {/if}

      <!-- One row per person -->
      {#each rows as person (person.employeeId)}
        {@const layout = layouts.get(person.employeeId) ?? { bars: [], lanes: 1 }}
        <div class="tl-line tl-person" data-testid="plan-row-{person.employeeId}">
          <div class="tl-name" class:tl-name--own={person.isOwn} title={person.name}>
            {person.name}
          </div>
          {#if isYear}
            <div
              class="tl-track tl-track--weeks"
              data-testid="plan-track-{person.employeeId}"
              style:width="{trackWidth}px"
            >
              {#each cellsByPerson.get(person.employeeId) ?? [] as cell, i (cell.monday)}
                {@const week = weeks[i]}
                {@const color = cellColor(cell)}
                <button
                  type="button"
                  class="tl-week"
                  class:tl-week--beantragt={cell.hasBeantragt}
                  class:tl-week--wish={cell.hasWish}
                  class:tl-week--edge={cell.outOfYearDays > 0}
                  data-testid="week-cell-{person.employeeId}-{cell.monday}"
                  style:left="{i * columnWidth}px"
                  style:width="{columnWidth}px"
                  style:--bar-fill="var({color.fill})"
                  title={weekLabel(week, cell)}
                  aria-label="{person.name}: {weekLabel(week, cell)}"
                  onclick={() => onWeekSelect?.(cell.monday)}
                  onkeydown={(event) => onWeekKeydown(event, cell.monday)}
                >
                  {#if cell.share > 0}
                    <span class="tl-week-fill" style:height="{cell.share * 100}%"></span>
                  {/if}
                  {#if cell.outOfYearDays > 0}
                    <span
                      class="tl-week-out"
                      class:tl-week-out--end={cell.monday >= period.startDay}
                      style:width="{(cell.outOfYearDays / 7) * 100}%"
                    ></span>
                  {/if}
                </button>
              {/each}
            </div>
          {:else}
            <!-- svelte-ignore a11y_click_events_have_key_events, a11y_no_static_element_interactions -->
            <div
              class="tl-track"
              class:tl-track--addable={onAddWish !== undefined && canAddWishFor(person.employeeId)}
              data-testid="plan-track-{person.employeeId}"
              style:width="{trackWidth}px"
              style:height="{layout.lanes * LANE_HEIGHT + 8}px"
              onclick={(event) => onTrackClick(event, person)}
            >
              {#each weekendRuns as run (run.left)}
                <div class="tl-weekend" style:left="{run.left}px" style:width="{run.width}px"></div>
              {/each}
              {#each closedCells as closed (closed.day)}
                <div
                  class="tl-closed"
                  style:left="{closed.left}px"
                  style:width="{columnWidth}px"
                ></div>
              {/each}
              {#each holidayCells as holiday (holiday.day)}
                <div
                  class="tl-holiday"
                  data-testid="plan-holiday-{holiday.day}"
                  style:left="{holiday.left}px"
                  style:width="{columnWidth}px"
                ></div>
              {/each}
              {#each person.outsideRanges ?? [] as away, i (i)}
                {@const from = dayIndex(period.year, away.start) - startIndex}
                {@const to = dayIndex(period.year, away.end) - startIndex}
                {#if to >= 0 && from < count}
                  <div
                    class="tl-away"
                    style:left="{Math.max(from, 0) * columnWidth}px"
                    style:width="{(Math.min(to, count - 1) - Math.max(from, 0) + 1) *
                      columnWidth}px"
                  ></div>
                {/if}
              {/each}
              {#if todayLeft !== null}
                <div class="tl-today" style:left="{todayLeft + columnWidth / 2 - 1}px"></div>
              {/if}

              {#each layout.bars as placed (placed.bar.key)}
                {@const bar = placed.bar}
                {#if bar.style === "wunsch"}
                  <div
                    class="absence-bar absence-bar--wunsch absence-wish"
                    class:absence-wish--conflict={bar.conflict}
                    class:absence-wish--readonly={!bar.editable}
                    class:absence-wish--dragging={drag?.key === bar.key}
                    data-testid="leave-plan-wish-{bar.key}"
                    data-bar-style="wunsch"
                    style:left="{placed.left}px"
                    style:width="{placed.width}px"
                    style:top="{4 + placed.lane * LANE_HEIGHT}px"
                  >
                    {#if bar.foreignPlan}
                      <span
                        class="absence-wish-body absence-wish-body--static"
                        role="img"
                        aria-label={wishAriaLabel(person, bar)}
                        title={barTitle(bar)}
                      >
                        {#if placed.width >= LABEL_MIN_WIDTH}{bar.label}{/if}
                      </span>
                    {:else}
                      <button
                        type="button"
                        class="absence-wish-body"
                        data-testid="wish-bar-{bar.key}"
                        aria-label={wishAriaLabel(person, bar)}
                        title={barTitle(bar)}
                        onpointerdown={(event) => beginDrag(event, bar, "move")}
                        onpointermove={(event) => moveDrag(event, bar)}
                        onpointerup={(event) => endDrag(event, bar)}
                        onpointercancel={cancelDrag}
                        onclick={(event) => onWishClick(event, bar)}
                        onkeydown={(event) => onWishKeydown(event, bar)}
                      >
                        {#if placed.width >= LABEL_MIN_WIDTH}{bar.label}{/if}
                      </button>
                      {#if bar.editable}
                        <span
                          class="absence-handle absence-handle--start"
                          role="presentation"
                          data-testid="leave-plan-wish-handle-start-{bar.key}"
                          onpointerdown={(event) => beginDrag(event, bar, "start")}
                          onpointermove={(event) => moveDrag(event, bar)}
                          onpointerup={(event) => endDrag(event, bar)}
                          onpointercancel={cancelDrag}
                        ></span>
                        <span
                          class="absence-handle absence-handle--end"
                          role="presentation"
                          data-testid="leave-plan-wish-handle-end-{bar.key}"
                          onpointerdown={(event) => beginDrag(event, bar, "end")}
                          onpointermove={(event) => moveDrag(event, bar)}
                          onpointerup={(event) => endDrag(event, bar)}
                          onpointercancel={cancelDrag}
                        ></span>
                      {/if}
                    {/if}
                  </div>
                {:else}
                  {@const color = barColor(bar)}
                  <button
                    type="button"
                    class="absence-bar absence-bar--{bar.style}"
                    class:absence-bar--selectable={onBarSelect !== undefined}
                    data-testid="absence-bar-{bar.key}"
                    data-bar-style={bar.style}
                    style:left="{placed.left}px"
                    style:width="{placed.width}px"
                    style:top="{4 + placed.lane * LANE_HEIGHT}px"
                    style:--bar-fill="var({color.fill})"
                    style:--bar-text="var({color.text})"
                    title={barTitle(bar)}
                    aria-label="{person.name}: {barTitle(bar)}"
                    onclick={() => onBarSelect?.(bar)}
                    onkeydown={(event) => onBarKeydown(event, bar)}
                  >
                    {#if placed.width >= LABEL_MIN_WIDTH}{bar.label}{/if}
                  </button>
                {/if}
              {/each}
            </div>
          {/if}
          {#if showForecast}
            <div class="tl-forecast" data-testid="plan-forecast-{person.employeeId}">
              {#if person.forecast}
                <span>{forecastLabel(person.forecast.forecastDays)}</span>
                {#if person.forecast.forecastNegative}
                  <span class="badge badge-red">{FORECAST_WARNING}</span>
                {/if}
              {/if}
            </div>
          {/if}
        </div>
      {/each}
    </div>
  </div>
  {#if showMoreHint}
    <div
      class="tl-fade"
      class:tl-fade--forecast={showForecast}
      data-testid="timeline-overflow-fade"
      aria-hidden="true"
    ></div>
    <span
      class="tl-more"
      class:tl-more--forecast={showForecast}
      data-testid="timeline-overflow-hint"
      aria-hidden="true">weiter →</span
    >
  {/if}
</div>

<style>
  .absence-timeline {
    position: relative;
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

  .tl-name--own {
    font-weight: 600;
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
    touch-action: pan-y;
  }

  .tl-track--head {
    height: 52px;
    background-image: none;
  }

  .tl-track--weeks {
    height: 36px;
    background-image: none;
  }

  .tl-track--addable {
    cursor: cell;
  }

  /* Month names. Quartal and Monat keep them in view next to the sticky name column. */
  .tl-month {
    position: absolute;
    top: 0;
    height: 22px;
    border-left: 1px solid var(--border);
    font-size: 0.8125rem;
    font-weight: 500;
    color: var(--text);
    line-height: 22px;
    white-space: nowrap;
    overflow: hidden;
  }

  .tl-month--sticky {
    overflow: visible;
  }

  .tl-month-label {
    padding: 0 0.5rem;
  }

  .tl-month--sticky .tl-month-label {
    position: sticky;
    left: calc(var(--tl-name-w) + 0.25rem);
    display: inline-block;
  }

  .tl-weekhead {
    position: absolute;
    top: 22px;
    height: 30px;
    box-sizing: border-box;
    display: flex;
    align-items: center;
    justify-content: center;
    border-left: 1px solid var(--border);
    font-size: 0.6875rem;
    font-variant-numeric: tabular-nums;
    color: var(--text-muted);
  }

  .tl-weekhead--today {
    background: var(--brand-soft);
    color: var(--text);
    font-weight: 600;
  }

  .absence-day {
    position: absolute;
    top: 22px;
    height: 30px;
    box-sizing: border-box;
    margin: 0;
    padding: 0;
    border: none;
    background: transparent;
    font: inherit;
    display: flex;
    flex-direction: column;
    align-items: center;
    justify-content: center;
    font-size: 0.6875rem;
    line-height: 1.1;
    color: var(--text-muted);
  }

  button.absence-day {
    cursor: help;
  }

  button.absence-day:focus-visible {
    outline: 2px solid var(--brand);
    outline-offset: -2px;
  }

  /* Issue 840 G-2: one visible weekend token for the header cell and the tracks (no opacity dilution). */
  .absence-day--weekend {
    background: var(--weekend-shade);
  }

  .absence-day--closed {
    background-image: repeating-linear-gradient(
      135deg,
      var(--border) 0,
      var(--border) 1px,
      transparent 1px,
      transparent 5px
    );
  }

  .absence-day--holiday {
    background: var(--warn-soft);
    color: var(--text);
  }

  .absence-day--today {
    box-shadow: inset 0 -3px 0 var(--brand);
    color: var(--text);
    font-weight: 600;
  }

  .absence-day-number {
    font-variant-numeric: tabular-nums;
    white-space: nowrap;
  }

  .tl-weekend,
  .tl-closed,
  .tl-away,
  .tl-holiday {
    position: absolute;
    top: 0;
    bottom: 0;
    pointer-events: none;
  }

  .tl-weekend {
    background: var(--weekend-shade);
  }

  .tl-closed {
    background-image: repeating-linear-gradient(
      135deg,
      var(--border) 0,
      var(--border) 1px,
      transparent 1px,
      transparent 5px
    );
  }

  .tl-away {
    background: var(--bg-subtle);
    opacity: 0.8;
  }

  .tl-holiday {
    background: var(--warn-soft);
  }

  .tl-today {
    position: absolute;
    top: 0;
    bottom: 0;
    width: 2px;
    background: var(--brand);
    opacity: 0.55;
    pointer-events: none;
  }

  /* Load row */
  .tl-load-cell {
    position: absolute;
    top: 2px;
    bottom: 2px;
    display: flex;
    align-items: center;
    justify-content: center;
    font-size: 0.75rem;
    font-variant-numeric: tabular-nums;
    color: var(--text);
    background: color-mix(in srgb, var(--brand) var(--tl-load-share), transparent);
    border-radius: var(--r-sm);
  }

  .tl-load-cell--exceeded {
    background: var(--bad-soft);
    color: var(--bad-text);
    outline: 2px solid var(--bad);
    outline-offset: -2px;
    font-weight: 600;
  }

  /* Jahr: week cells */
  .tl-week {
    position: absolute;
    top: 4px;
    height: 28px;
    box-sizing: border-box;
    margin: 0;
    padding: 0;
    overflow: hidden;
    background: var(--bg-card);
    border: 1px solid var(--border);
    cursor: pointer;
  }

  .tl-week:focus-visible {
    outline: 2px solid var(--brand);
    outline-offset: -2px;
    z-index: 2;
  }

  .tl-week-fill {
    position: absolute;
    left: 0;
    right: 0;
    bottom: 0;
    min-height: 2px;
    background: var(--bar-fill);
  }

  /* A requested day in the week: dashed 2 px border in the type colour. */
  .tl-week--beantragt {
    border: 2px dashed var(--bar-fill);
  }

  /* A wish in the week: diagonal brand stripes over the cell. */
  .tl-week--wish::after {
    content: "";
    position: absolute;
    inset: 0;
    background: repeating-linear-gradient(
      45deg,
      color-mix(in srgb, var(--brand) 55%, transparent) 0,
      color-mix(in srgb, var(--brand) 55%, transparent) 2px,
      transparent 2px,
      transparent 5px
    );
    pointer-events: none;
  }

  /* The days of an edge week that lie outside the year: muted hatch, excluded from the share. */
  .tl-week-out {
    position: absolute;
    top: 0;
    bottom: 0;
    left: 0;
    background: repeating-linear-gradient(
      135deg,
      var(--text-faint) 0,
      var(--text-faint) 1px,
      var(--bg-subtle) 1px,
      var(--bg-subtle) 4px
    );
    pointer-events: none;
  }

  .tl-week-out--end {
    left: auto;
    right: 0;
  }

  /* Quartal, Monat: bars */
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

  .absence-bar--selectable {
    cursor: pointer;
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

  /* Absent: solid neutral — the reader may not learn the type. */
  .absence-bar--abwesend {
    background: var(--bar-fill);
    border: 2px solid var(--bar-fill);
    color: var(--bar-text);
  }

  /* Wish: diagonal brand stripes with an outline. */
  .absence-bar--wunsch {
    padding: 0;
    overflow: visible;
    background:
      repeating-linear-gradient(
        45deg,
        color-mix(in srgb, var(--brand) 30%, transparent) 0,
        color-mix(in srgb, var(--brand) 30%, transparent) 4px,
        transparent 4px,
        transparent 8px
      ),
      var(--brand-soft);
    border: 2px solid var(--brand);
    color: var(--text);
    z-index: 2;
  }

  .absence-wish--conflict {
    border-color: var(--warn);
  }

  .absence-wish--readonly {
    border-style: dotted;
  }

  .absence-wish--dragging {
    opacity: 0.85;
    box-shadow: var(--shadow-md);
    z-index: 4;
  }

  .absence-wish-body {
    display: block;
    width: 100%;
    height: 100%;
    padding: 0 0.35rem;
    border: none;
    background: transparent;
    font: inherit;
    font-size: 0.75rem;
    color: var(--text);
    text-align: left;
    line-height: 16px;
    overflow: hidden;
    white-space: nowrap;
    cursor: grab;
    touch-action: none;
  }

  .absence-wish-body:focus-visible {
    outline: 2px solid var(--brand);
    outline-offset: 1px;
  }

  .absence-wish--readonly .absence-wish-body {
    cursor: pointer;
  }

  .absence-wish-body--static {
    cursor: default;
  }

  .absence-handle {
    position: absolute;
    top: -2px;
    bottom: -2px;
    width: 8px;
    background: var(--brand);
    border-radius: var(--r-sm);
    cursor: ew-resize;
    touch-action: none;
  }

  .absence-handle--start {
    left: -4px;
  }

  .absence-handle--end {
    right: -4px;
  }

  /* Forecast column („Anspruch“) of the planner */
  .tl-forecast {
    position: sticky;
    right: 0;
    z-index: 3;
    flex: none;
    width: var(--tl-forecast-w);
    padding: 0.35rem 0.75rem;
    background: var(--bg-card);
    border-left: 1px solid var(--border);
    font-size: 0.8125rem;
    color: var(--text);
    display: flex;
    flex-direction: column;
    justify-content: center;
    gap: 0.25rem;
  }

  .tl-forecast--head {
    font-weight: 500;
  }

  /* Overflow: a fade at the right edge and a hint, while there is more to scroll to. */
  .tl-fade {
    position: absolute;
    top: 0;
    right: 0;
    bottom: 0;
    width: 48px;
    background: linear-gradient(to right, transparent, var(--bg-card));
    border-radius: 0 var(--r-md) var(--r-md) 0;
    pointer-events: none;
    z-index: 4;
  }

  .tl-fade--forecast {
    right: var(--tl-forecast-w);
  }

  .tl-more {
    position: absolute;
    top: 4px;
    right: 8px;
    z-index: 5;
    padding: 0 0.4rem;
    border-radius: var(--r-sm);
    background: var(--bg-card);
    font-size: 0.75rem;
    color: var(--text-muted);
    pointer-events: none;
  }

  .tl-more--forecast {
    right: calc(var(--tl-forecast-w) + 8px);
  }
</style>

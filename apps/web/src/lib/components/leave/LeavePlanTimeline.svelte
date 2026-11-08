<script lang="ts">
  /**
   * LeavePlanTimeline — Issue #835 (D-835-21/31/34).
   *
   * The desktop view of the leave planner: one row per person, one column per day. Rows that are
   * already decided are drawn solid (gesetzt) or dashed (beantragt), wishes are draggable (move)
   * and resizable (both edges) with pointer events. The component writes nothing: a finished drag
   * calls `onMoveWish` once with the new range and the parent saves and reloads — the server stays
   * authoritative and refuses what is not allowed.
   *
   * A wish that cannot be changed (another plan's wish, a taken-over wish, `editable: false`) has no
   * handles and ignores drags. Enter on a wish opens the edit form (`onEditWish`), the keyboard
   * alternative to dragging. The day-load row shows the team's „Urlaub“ count per day and marks a
   * day as exceeded only when the API sent rule data (`limits`, manage/approve reach only).
   *
   * This component renders no dialog (#570: an animated Section traps fixed dialogs) and imports
   * neither the auth store nor the API client, so it stays mountable in vitest.
   */
  import { onMount } from "svelte";
  import { ABSENT, leaveTypeColor } from "$lib/leave/leave-colors"; // Issue #840 (D-840-12)
  import {
    assignLanes,
    dayFromIndex,
    dayIndex,
    daysInYear,
    monthSegments,
    moveRange,
    pointerDeltaToDays,
    rangeToColumns,
    resizeRange,
    viewWindow,
    type TimelineView,
  } from "$lib/leave-plan/timeline";
  import {
    DAY_LOAD_HINT,
    DAY_LOAD_LABEL,
    FORECAST_WARNING,
    HOLIDAY_LABEL,
    ROW_STATE_LABELS,
    WISH_CONFLICT_HINT,
    WISH_FOREIGN_PLAN_HINT,
    WISH_TAKEN_OVER_HINT,
    forecastLabel,
    rowTypeLabel,
  } from "$lib/leave-plan/labels";
  import type {
    DayRange,
    PlannerDay,
    PlannerHoliday,
    PlannerPerson,
    PlannerRow,
    PlannerWish,
  } from "$lib/leave-plan/types";

  interface Props {
    year: number;
    /** "year" or a month index 0-11. */
    view: TimelineView;
    persons: PlannerPerson[];
    holidays: PlannerHoliday[];
    dayLoad: PlannerDay[];
    showForecast: boolean;
    onMoveWish: (wish: PlannerWish, range: DayRange) => void | Promise<void>;
    onEditWish: (wish: PlannerWish) => void;
    onAddWish: (employeeId: string, day: string) => void;
    /** Whether a click on an empty day of this person's row may start a wish. Default: yes. */
    canAddWishFor?: (employeeId: string) => boolean;
    /** Measured from the grid when absent; tests pass it. */
    columnWidthPx?: number;
  }

  let {
    year,
    view,
    persons,
    holidays,
    dayLoad,
    showForecast,
    onMoveWish,
    onEditWish,
    onAddWish,
    canAddWishFor = () => true,
    columnWidthPx,
  }: Props = $props();

  const NAME_WIDTH = 176;
  const FORECAST_WIDTH = 184;
  const LANE_HEIGHT = 24;

  // Measured once on mount and on window resize (no ResizeObserver: keeps the component mountable
  // in jsdom). Only used when `columnWidthPx` is absent.
  let rootEl: HTMLDivElement | undefined = $state();
  let measuredWidth = $state(0);

  function measure() {
    measuredWidth = rootEl?.clientWidth ?? 0;
  }

  onMount(() => {
    measure();
  });

  let window_ = $derived(viewWindow(year, view));
  let columnWidth = $derived.by(() => {
    if (columnWidthPx !== undefined) return columnWidthPx;
    if (measuredWidth <= 0) return 20;
    const available = measuredWidth - NAME_WIDTH - (showForecast ? FORECAST_WIDTH : 0);
    const minimum = view === "year" ? 4 : 24;
    return Math.max(minimum, available / window_.length);
  });
  let trackWidth = $derived(window_.length * columnWidth);
  let showDayNumbers = $derived(view !== "year");

  let months = $derived(
    monthSegments(year)
      .map((segment) => ({
        ...segment,
        visibleStart: Math.max(segment.startIndex, window_.startIndex),
        visibleEnd: Math.min(
          segment.startIndex + segment.length - 1,
          window_.startIndex + window_.length - 1,
        ),
      }))
      .filter((segment) => segment.visibleEnd >= segment.visibleStart),
  );
  let dayNumbers = $derived(
    showDayNumbers
      ? Array.from({ length: window_.length }, (_, i) => {
          const day = dayFromIndex(year, window_.startIndex + i);
          return { day, label: String(Number(day.slice(8))) };
        })
      : [],
  );

  let holidayCells = $derived(
    holidays.flatMap((holiday) => {
      const cols = rangeToColumns({ startDate: holiday.date, endDate: holiday.date }, year, view);
      return cols ? [{ ...holiday, left: (cols.startColumn - 1) * columnWidth }] : [];
    }),
  );

  let loadCells = $derived(
    dayLoad.flatMap((entry) => {
      const cols = rangeToColumns({ startDate: entry.day, endDate: entry.day }, year, view);
      if (!cols) return [];
      const exceeded = entry.limits !== null && entry.limits.some((limit) => limit.exceeded);
      return [{ ...entry, exceeded, left: (cols.startColumn - 1) * columnWidth }];
    }),
  );
  let maxLoad = $derived(Math.max(1, ...dayLoad.map((entry) => entry.count)));

  function fmtDate(iso: string): string {
    const [y, m, d] = iso.split("-");
    return `${d}.${m}.${y}`;
  }

  function personName(person: PlannerPerson): string {
    return `${person.firstName} ${person.lastName}`;
  }

  /** A wish the reader may change: no foreign plan, not taken over, and the server said so. */
  function isEditable(wish: PlannerWish): boolean {
    return wish.editable && !wish.foreignPlan && wish.leaveRequestId === null;
  }

  // ── Drag state ─────────────────────────────────────────────────────────────────────────────
  type DragMode = "move" | "start" | "end";
  let drag = $state<{
    wishId: string;
    mode: DragMode;
    startX: number;
    delta: number;
    base: DayRange;
  } | null>(null);
  let suppressClick = false;

  function previewRange(wish: PlannerWish): DayRange {
    const base: DayRange = { startDate: wish.startDate, endDate: wish.endDate };
    if (!drag || drag.wishId !== wish.id) return base;
    if (drag.mode === "move") return moveRange(drag.base, drag.delta, year);
    return resizeRange(drag.base, drag.mode, drag.delta, year);
  }

  function beginDrag(event: PointerEvent, wish: PlannerWish, mode: DragMode) {
    if (!isEditable(wish) || event.button !== 0) return;
    event.stopPropagation();
    const target = event.currentTarget as HTMLElement;
    if (typeof target.setPointerCapture === "function") target.setPointerCapture(event.pointerId);
    drag = {
      wishId: wish.id,
      mode,
      startX: event.clientX,
      delta: 0,
      base: { startDate: wish.startDate, endDate: wish.endDate },
    };
  }

  function moveDrag(event: PointerEvent, wish: PlannerWish) {
    if (!drag || drag.wishId !== wish.id) return;
    drag.delta = pointerDeltaToDays(event.clientX - drag.startX, columnWidth);
  }

  function endDrag(event: PointerEvent, wish: PlannerWish) {
    if (!drag || drag.wishId !== wish.id) return;
    const finished = drag;
    drag = null;
    const delta = pointerDeltaToDays(event.clientX - finished.startX, columnWidth);
    if (delta === 0) return;
    suppressClick = true;
    setTimeout(() => (suppressClick = false), 0);
    const range =
      finished.mode === "move"
        ? moveRange(finished.base, delta, year)
        : resizeRange(finished.base, finished.mode, delta, year);
    if (range.startDate === finished.base.startDate && range.endDate === finished.base.endDate) {
      return;
    }
    void onMoveWish(wish, range);
  }

  function cancelDrag() {
    drag = null;
  }

  function onWishClick(event: MouseEvent, wish: PlannerWish) {
    event.stopPropagation();
    if (suppressClick) {
      suppressClick = false;
      return;
    }
    onEditWish(wish);
  }

  function onWishKeydown(event: KeyboardEvent, wish: PlannerWish) {
    if (event.key !== "Enter") return;
    event.preventDefault();
    onEditWish(wish);
  }

  // ── Layout per person ──────────────────────────────────────────────────────────────────────
  type Item =
    | { kind: "row"; row: PlannerRow; left: number; width: number; lane: number; key: string }
    | { kind: "wish"; wish: PlannerWish; lane: number; key: string };

  function itemsOf(person: PlannerPerson): { items: Item[]; lanes: number } {
    const raw: Array<{
      start: number;
      end: number;
      make: (lane: number) => Item;
    }> = [];
    person.rows.forEach((row, i) => {
      const cols = rangeToColumns(row, year, view);
      if (!cols) return;
      raw.push({
        start: dayIndex(year, row.startDate),
        end: dayIndex(year, row.endDate),
        make: (lane) => ({
          kind: "row",
          row,
          left: (cols.startColumn - 1) * columnWidth,
          width: cols.span * columnWidth,
          lane,
          key: `row-${i}`,
        }),
      });
    });
    for (const wish of person.wishes) {
      const shown = rangeToColumns(previewRange(wish), year, view);
      if (!shown) continue;
      const range = previewRange(wish);
      raw.push({
        start: dayIndex(year, range.startDate),
        end: dayIndex(year, range.endDate),
        make: (lane) => ({ kind: "wish", wish, lane, key: `wish-${wish.id}` }),
      });
    }
    const lanes = assignLanes(raw);
    return {
      items: raw.map((entry, i) => entry.make(lanes[i])),
      lanes: Math.max(1, ...lanes.map((lane) => lane + 1)),
    };
  }

  let layouts = $derived(new Map(persons.map((person) => [person.employeeId, itemsOf(person)])));

  /** Days outside the person's Stammsalon span, shaded (a wish makes no sense there). */
  function awayCells(person: PlannerPerson): Array<{ left: number; width: number }> {
    const last = daysInYear(year) - 1;
    const gaps: DayRange[] = [];
    let cursor = 0;
    const home = [...person.homeRanges].sort((a, b) => a.from.localeCompare(b.from));
    for (const range of home) {
      const start = dayIndex(year, range.from);
      if (start > cursor) {
        gaps.push({
          startDate: dayFromIndex(year, cursor),
          endDate: dayFromIndex(year, start - 1),
        });
      }
      cursor = Math.max(cursor, dayIndex(year, range.to) + 1);
    }
    if (cursor <= last) {
      gaps.push({ startDate: dayFromIndex(year, cursor), endDate: dayFromIndex(year, last) });
    }
    return gaps.flatMap((gap) => {
      const cols = rangeToColumns(gap, year, view);
      return cols
        ? [{ left: (cols.startColumn - 1) * columnWidth, width: cols.span * columnWidth }]
        : [];
    });
  }

  function isHomeDay(person: PlannerPerson, day: string): boolean {
    return person.homeRanges.some((range) => day >= range.from && day <= range.to);
  }

  function onTrackClick(event: MouseEvent, person: PlannerPerson) {
    if (event.target !== event.currentTarget) return;
    if (!canAddWishFor(person.employeeId)) return;
    const rect = (event.currentTarget as HTMLElement).getBoundingClientRect();
    const column = Math.floor((event.clientX - rect.left) / columnWidth);
    if (column < 0 || column >= window_.length) return;
    const day = dayFromIndex(year, window_.startIndex + column);
    if (!isHomeDay(person, day)) return;
    onAddWish(person.employeeId, day);
  }

  // ── Visuals ────────────────────────────────────────────────────────────────────────────────
  function rowColorVar(row: PlannerRow): string {
    // #840 (D-840-12): the colour of a type comes from the one mapping.
    if (row.kind === "COMPANY_SHUTDOWN") return ABSENT.fill;
    return leaveTypeColor(row.typeCode).fill;
  }

  function rowTitle(row: PlannerRow): string {
    const state = ROW_STATE_LABELS[row.state];
    return `${rowTypeLabel(row)} (${state}): ${fmtDate(row.startDate)} – ${fmtDate(row.endDate)}${row.halfDay ? ", halber Tag" : ""}`;
  }

  function wishLabel(wish: PlannerWish): string {
    const range = `${fmtDate(wish.startDate)} bis ${fmtDate(wish.endDate)}${wish.halfDay ? ", halber Tag" : ""}`;
    const hints = [
      wish.leaveRequestId !== null ? WISH_TAKEN_OVER_HINT : null,
      wish.conflict ? WISH_CONFLICT_HINT : null,
    ].filter((hint) => hint !== null);
    const suffix = hints.length > 0 ? `. ${hints.join(". ")}` : "";
    return isEditable(wish)
      ? `Wunsch vom ${range}${suffix}. Mit Enter bearbeiten.`
      : `Wunsch vom ${range}${suffix}.`;
  }

  function loadLabel(entry: { day: string; count: number; exceeded: boolean }): string {
    return `${fmtDate(entry.day)}: ${entry.count} ${DAY_LOAD_LABEL}${entry.exceeded ? ", Grenze überschritten" : ""}`;
  }
</script>

<svelte:window onresize={measure} />

<div
  class="plan-timeline"
  data-testid="leave-plan-timeline"
  bind:this={rootEl}
  style:--plan-name-w="{NAME_WIDTH}px"
  style:--plan-forecast-w="{FORECAST_WIDTH}px"
  style:--plan-col-w="{columnWidth}px"
  style:--plan-lane-h="{LANE_HEIGHT}px"
>
  <div class="plan-scroll">
    <div
      class="plan-inner"
      style:min-width="{NAME_WIDTH + trackWidth + (showForecast ? FORECAST_WIDTH : 0)}px"
    >
      <!-- Month header (and day numbers in the month view) -->
      <div class="plan-line plan-head">
        <div class="plan-name plan-name--head"></div>
        <div class="plan-track plan-track--head" style:width="{trackWidth}px">
          {#each months as month (month.month)}
            <div
              class="plan-month"
              data-testid="plan-month-{month.month}"
              style:left="{(month.visibleStart - window_.startIndex) * columnWidth}px"
              style:width="{(month.visibleEnd - month.visibleStart + 1) * columnWidth}px"
            >
              {month.label}
            </div>
          {/each}
          {#if showDayNumbers}
            {#each dayNumbers as number, i (number.day)}
              <div
                class="plan-daynum"
                style:left="{i * columnWidth}px"
                style:width="{columnWidth}px"
              >
                {number.label}
              </div>
            {/each}
          {/if}
        </div>
        {#if showForecast}<div class="plan-forecast plan-forecast--head">Anspruch</div>{/if}
      </div>

      <!-- Day load: the team's „Urlaub“ count per day -->
      <div class="plan-line plan-load" data-testid="plan-day-load">
        <div class="plan-name" title={DAY_LOAD_HINT}>{DAY_LOAD_LABEL}</div>
        <div class="plan-track" style:width="{trackWidth}px" style:height="28px">
          {#each loadCells as cell (cell.day)}
            <div
              class="plan-load-cell"
              class:plan-load-cell--exceeded={cell.exceeded}
              data-testid="day-load-{cell.day}"
              data-exceeded={cell.exceeded ? "true" : "false"}
              style:left="{cell.left}px"
              style:width="{columnWidth}px"
              style:--plan-load-share="{Math.round((cell.count / maxLoad) * 60) + 15}%"
              title={loadLabel(cell)}
              aria-label={loadLabel(cell)}
            >
              {#if columnWidth >= 14}{cell.count}{/if}
            </div>
          {/each}
        </div>
        {#if showForecast}<div class="plan-forecast"></div>{/if}
      </div>

      <!-- One row per person -->
      {#each persons as person (person.employeeId)}
        {@const layout = layouts.get(person.employeeId) ?? { items: [], lanes: 1 }}
        <div class="plan-line plan-person" data-testid="plan-row-{person.employeeId}">
          <div class="plan-name" title={personName(person)}>{personName(person)}</div>
          <!-- svelte-ignore a11y_click_events_have_key_events, a11y_no_static_element_interactions -->
          <div
            class="plan-track"
            class:plan-track--addable={canAddWishFor(person.employeeId)}
            data-testid="plan-track-{person.employeeId}"
            style:width="{trackWidth}px"
            style:height="{layout.lanes * LANE_HEIGHT + 8}px"
            onclick={(event) => onTrackClick(event, person)}
          >
            {#each awayCells(person) as away, i (i)}
              <div class="plan-away" style:left="{away.left}px" style:width="{away.width}px"></div>
            {/each}
            {#each holidayCells as holiday (holiday.date)}
              <div
                class="plan-holiday"
                data-testid="plan-holiday-{holiday.date}"
                style:left="{holiday.left}px"
                style:width="{columnWidth}px"
                title="{HOLIDAY_LABEL}: {holiday.name}"
              ></div>
            {/each}

            {#each layout.items as item (item.key)}
              {#if item.kind === "row"}
                <div
                  class="plan-bar"
                  class:plan-bar--gesetzt={item.row.state === "GESETZT"}
                  class:plan-bar--beantragt={item.row.state === "BEANTRAGT"}
                  data-testid="plan-bar-{item.row.state === 'GESETZT' ? 'gesetzt' : 'beantragt'}"
                  style:left="{item.left}px"
                  style:width="{item.width}px"
                  style:top="{4 + item.lane * LANE_HEIGHT}px"
                  style:--plan-bar-color="var({rowColorVar(item.row)})"
                  title={rowTitle(item.row)}
                >
                  {#if item.width >= 60}{rowTypeLabel(item.row)}{/if}
                </div>
              {:else}
                {@const wish = item.wish}
                {@const range = previewRange(wish)}
                {@const cols = rangeToColumns(range, year, view)}
                {#if cols}
                  {@const left = (cols.startColumn - 1) * columnWidth}
                  {@const width = cols.span * columnWidth}
                  {@const editable = isEditable(wish)}
                  <div
                    class="plan-bar plan-wish"
                    class:plan-wish--conflict={wish.conflict}
                    class:plan-wish--readonly={!editable}
                    class:plan-wish--dragging={drag?.wishId === wish.id}
                    data-testid="leave-plan-wish-{wish.id}"
                    style:left="{left}px"
                    style:width="{width}px"
                    style:top="{4 + item.lane * LANE_HEIGHT}px"
                  >
                    {#if wish.foreignPlan}
                      <span
                        class="plan-wish-body plan-wish-body--static"
                        role="img"
                        aria-label="{wishLabel(wish)} {WISH_FOREIGN_PLAN_HINT}."
                        title={WISH_FOREIGN_PLAN_HINT}
                      >
                        {ROW_STATE_LABELS.WISH}
                      </span>
                    {:else}
                      <button
                        type="button"
                        class="plan-wish-body"
                        data-testid="wish-bar-{wish.id}"
                        aria-label={wishLabel(wish)}
                        title={wishLabel(wish)}
                        onpointerdown={(event) => beginDrag(event, wish, "move")}
                        onpointermove={(event) => moveDrag(event, wish)}
                        onpointerup={(event) => endDrag(event, wish)}
                        onpointercancel={cancelDrag}
                        onclick={(event) => onWishClick(event, wish)}
                        onkeydown={(event) => onWishKeydown(event, wish)}
                      >
                        {#if width >= 60}{ROW_STATE_LABELS.WISH}{/if}
                      </button>
                      {#if editable}
                        <span
                          class="plan-handle plan-handle--start"
                          role="presentation"
                          data-testid="leave-plan-wish-handle-start-{wish.id}"
                          onpointerdown={(event) => beginDrag(event, wish, "start")}
                          onpointermove={(event) => moveDrag(event, wish)}
                          onpointerup={(event) => endDrag(event, wish)}
                          onpointercancel={cancelDrag}
                        ></span>
                        <span
                          class="plan-handle plan-handle--end"
                          role="presentation"
                          data-testid="leave-plan-wish-handle-end-{wish.id}"
                          onpointerdown={(event) => beginDrag(event, wish, "end")}
                          onpointermove={(event) => moveDrag(event, wish)}
                          onpointerup={(event) => endDrag(event, wish)}
                          onpointercancel={cancelDrag}
                        ></span>
                      {/if}
                    {/if}
                  </div>
                {/if}
              {/if}
            {/each}
          </div>
          {#if showForecast}
            <div class="plan-forecast" data-testid="plan-forecast-{person.employeeId}">
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
</div>

<style>
  .plan-timeline {
    width: 100%;
    background: var(--bg-card);
    border: 1px solid var(--border);
    border-radius: var(--r-md);
  }

  .plan-scroll {
    overflow-x: auto;
  }

  .plan-inner {
    position: relative;
  }

  .plan-line {
    display: flex;
    align-items: stretch;
    border-bottom: 1px solid var(--border);
  }

  .plan-line:last-child {
    border-bottom: none;
  }

  .plan-name {
    position: sticky;
    left: 0;
    z-index: 3;
    flex: none;
    width: var(--plan-name-w);
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

  .plan-track {
    position: relative;
    flex: none;
    min-height: 28px;
    background-image: repeating-linear-gradient(
      to right,
      transparent 0,
      transparent calc(var(--plan-col-w) - 1px),
      var(--border) calc(var(--plan-col-w) - 1px),
      var(--border) var(--plan-col-w)
    );
    background-size: 100% 100%;
    touch-action: pan-y;
  }

  .plan-track--head {
    height: 44px;
    background-image: none;
  }

  .plan-track--addable {
    cursor: cell;
  }

  .plan-month {
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

  .plan-daynum {
    position: absolute;
    top: 22px;
    height: 22px;
    text-align: center;
    font-size: 0.75rem;
    line-height: 22px;
    color: var(--text-muted);
  }

  .plan-load-cell {
    position: absolute;
    top: 2px;
    bottom: 2px;
    display: flex;
    align-items: center;
    justify-content: center;
    font-size: 0.75rem;
    font-variant-numeric: tabular-nums;
    color: var(--text);
    background: color-mix(in srgb, var(--brand) var(--plan-load-share), transparent);
    border-radius: var(--r-sm);
  }

  .plan-load-cell--exceeded {
    background: var(--bad-soft);
    color: var(--bad-text);
    outline: 2px solid var(--bad);
    outline-offset: -2px;
    font-weight: 600;
  }

  .plan-away {
    position: absolute;
    top: 0;
    bottom: 0;
    background: var(--bg-subtle);
    opacity: 0.8;
    pointer-events: none;
  }

  .plan-holiday {
    position: absolute;
    top: 0;
    bottom: 0;
    background: var(--warn-soft);
    pointer-events: auto;
  }

  .plan-bar {
    position: absolute;
    height: 20px;
    box-sizing: border-box;
    border-radius: var(--r-sm);
    font-size: 0.75rem;
    line-height: 20px;
    padding: 0 0.35rem;
    overflow: hidden;
    white-space: nowrap;
    color: var(--text);
  }

  .plan-bar--gesetzt {
    background: var(--plan-bar-color);
    border: 2px solid var(--plan-bar-color);
    color: var(--text-on-brand);
  }

  .plan-bar--beantragt {
    background: color-mix(in srgb, var(--plan-bar-color) 18%, transparent);
    border: 2px dashed var(--plan-bar-color);
  }

  .plan-wish {
    padding: 0;
    overflow: visible;
    background: var(--brand-soft);
    border: 2px solid var(--brand);
    z-index: 2;
  }

  .plan-wish--conflict {
    border-color: var(--warn);
  }

  .plan-wish--readonly {
    border-style: dotted;
  }

  .plan-wish--dragging {
    opacity: 0.85;
    box-shadow: 0 2px 8px rgba(0, 0, 0, 0.15);
    z-index: 4;
  }

  .plan-wish-body {
    display: block;
    width: 100%;
    height: 100%;
    padding: 0 0.35rem;
    border: none;
    background: transparent;
    font: inherit;
    color: var(--text);
    text-align: left;
    line-height: 16px;
    overflow: hidden;
    cursor: grab;
    touch-action: none;
  }

  .plan-wish-body:focus-visible {
    outline: 2px solid var(--brand);
    outline-offset: 1px;
  }

  .plan-wish--readonly .plan-wish-body {
    cursor: pointer;
  }

  .plan-wish-body--static {
    cursor: default;
  }

  .plan-handle {
    position: absolute;
    top: -2px;
    bottom: -2px;
    width: 8px;
    background: var(--brand);
    border-radius: var(--r-sm);
    cursor: ew-resize;
    touch-action: none;
  }

  .plan-handle--start {
    left: -4px;
  }

  .plan-handle--end {
    right: -4px;
  }

  .plan-forecast {
    position: sticky;
    right: 0;
    z-index: 3;
    flex: none;
    width: var(--plan-forecast-w);
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

  .plan-forecast--head {
    font-weight: 500;
  }
</style>

<script module lang="ts">
  /** Title of the disabled next arrow (Issue #612): the period may not move past the current month. */
  export const NEXT_PERIOD_DISABLED_TITLE = "Spätere Zeiträume liegen in der Zukunft.";

  /** The zoom levels a page may offer, in the order a picker lists them (D-843-01 block 2). */
  export type PeriodZoom = "jahr" | "quartal" | "monat" | "woche";
</script>

<script lang="ts">
  /**
   * PeriodPicker - Issue #843 (D-843-01 block 2 "Periodenwahl"): the one period control.
   * prev / label / next with 44 px touch targets, an optional "Heute" and - with more than one
   * zoom - a Segment of the zoom levels a page offers. Controlled: the page owns the period and
   * moves it in `onPrev` / `onNext` / `onToday` / `onZoom`; the picker only renders.
   *
   * It emits the legacy `.month-bar` DOM and the `{prefix}-*` test-id contract, so MonthBar,
   * PeriodSwitcher and the #553/#564 narrow-viewport proofs keep working on top of it.
   */
  import type { Snippet } from "svelte";
  import SegmentedControl from "./SegmentedControl.svelte";

  interface Props {
    /** The period text between the arrows, e.g. "November 2026". */
    label: string;
    onPrev: () => void;
    onNext: () => void;
    /** "Heute" jump - the button renders only when provided. */
    onToday?: () => void;
    /** aria-label AND title of the previous arrow. */
    prevLabel?: string;
    /** aria-label AND title of the next arrow. */
    nextLabel?: string;
    /** A real disabled next arrow whose title is {@link NEXT_PERIOD_DISABLED_TITLE}. */
    nextDisabled?: boolean;
    /** Emits `{prefix}`, `{prefix}-prev`, `{prefix}-next`, `{prefix}-today`, `{prefix}-label`. */
    testIdPrefix?: string;
    /** Small line above the label (e.g. "Buchungsmonat"). */
    eyebrow?: string;
    /** Zoom levels of this page, in display order; the Segment shows from two levels on. */
    zooms?: PeriodZoom[];
    zoom?: PeriodZoom;
    onZoom?: (zoom: PeriodZoom) => void;
    /** The label becomes a button (MonthBar's month grid); the overlay renders next to it. */
    onLabelClick?: () => void;
    labelTitle?: string;
    labelOverlay?: Snippet;
    /** Trailing actions inside the nav row (e.g. a PDF export button). */
    extra?: Snippet;
    /** Content that is not the period, rendered after it inside the same bar (MonthBar's stats). */
    aside?: Snippet;
  }

  let {
    label,
    onPrev,
    onNext,
    onToday,
    prevLabel = "Vorheriger Zeitraum",
    nextLabel = "Nächster Zeitraum",
    nextDisabled = false,
    testIdPrefix = "month-bar",
    eyebrow,
    zooms,
    zoom = $bindable("monat"),
    onZoom,
    onLabelClick,
    labelTitle,
    labelOverlay,
    extra,
    aside,
  }: Props = $props();

  const ZOOM_LABELS: Record<PeriodZoom, string> = {
    jahr: "Jahr",
    quartal: "Quartal",
    monat: "Monat",
    woche: "Woche",
  };

  const zoomOptions = $derived(
    (zooms ?? []).map((value) => ({ value, label: ZOOM_LABELS[value] })),
  );
</script>

<!-- The root is the legacy `.month-bar`: consumers wrap it in a card (or not) themselves. -->
<div class="month-bar" data-testid={testIdPrefix}>
  <div class="month-bar-nav">
    <button
      class="nav-btn"
      onclick={onPrev}
      title={prevLabel}
      aria-label={prevLabel}
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
      {#if onLabelClick}
        <button
          type="button"
          class="month-bar-label month-bar-label--picker"
          onclick={onLabelClick}
          title={labelTitle}
          data-testid={`${testIdPrefix}-label`}
        >
          {label}
          <svg
            width="12"
            height="12"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            stroke-width="2.5"
            aria-hidden="true"><polyline points="6 9 12 15 18 9" /></svg
          >
        </button>
        {@render labelOverlay?.()}
      {:else}
        <div class="month-bar-label" data-testid={`${testIdPrefix}-label`}>{label}</div>
      {/if}
    </div>
    <button
      class="nav-btn"
      onclick={onNext}
      disabled={nextDisabled}
      title={nextDisabled ? NEXT_PERIOD_DISABLED_TITLE : nextLabel}
      aria-label={nextLabel}
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
    {#if extra}
      <div class="month-bar-extra">{@render extra()}</div>
    {/if}
  </div>
  {#if zoomOptions.length > 1}
    <div class="month-bar-zoom">
      <SegmentedControl
        options={zoomOptions}
        bind:value={zoom}
        name={`${testIdPrefix}-zoom`}
        ariaLabel="Ansicht des Zeitraums"
        size="sm"
        onchange={(value) => onZoom?.(value as PeriodZoom)}
      />
    </div>
  {/if}
  {@render aside?.()}
</div>

<style>
  /* ── Period bar (moved here from MonthBar, Issue #843) ───────────────
     Dimensions kept in lockstep with .cal-monthbar (app.css) so /leave,
     /team/leave, /teamcal, /time-entries and /team/time-entries share
     the same header height and title. The narrow-viewport blocks below
     are mirrored there too (Issue #553): they stay viewport media queries
     on purpose - the .month-bar sits in content-sized flex parents
     (LeaveToolbar) where a container-type on this root would collapse its
     intrinsic width to zero, and the #553/#564 spec measures the viewport.
     Consumers must set the wrapping .card padding to 0 so the primitive
     owns the inner spacing. */
  .month-bar {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 24px;
    flex-wrap: nowrap;
    padding: 18px 24px;
  }

  .month-bar > .month-bar-nav {
    min-width: 0;
    flex: 0 1 auto;
  }

  .month-bar-nav {
    display: flex;
    align-items: center;
    gap: 8px;
    flex-wrap: nowrap;
  }

  /* 44 px touch target on both axes (WCAG 2.5.5); the global .nav-btn only sets the height. */
  .month-bar-nav .nav-btn {
    min-width: 44px;
    justify-content: center;
  }

  .month-bar-center {
    display: flex;
    flex-direction: column;
    align-items: center;
    min-width: 200px;
    text-align: center;
    position: relative;
  }

  .month-bar-eyebrow {
    font-family: var(--font-ui);
    color: var(--brand);
    font-size: 13px;
    line-height: 1;
    margin-bottom: 4px;
  }

  .month-bar-label {
    font-family: var(--font-ui);
    font-weight: 400;
    font-size: 26px;
    line-height: 1.1;
    color: var(--text);
    text-transform: capitalize;
    min-width: 9ch;
    text-align: center;
    white-space: nowrap;
  }

  /* Picker-trigger variant: matches .cal-monthbar-title look - chevron, hover. */
  .month-bar-label--picker {
    display: inline-flex;
    align-items: center;
    gap: 6px;
    background: none;
    border: 0;
    cursor: pointer;
    padding: 2px 4px;
    border-radius: var(--r-control);
    transition: color 0.15s ease;
  }
  .month-bar-label--picker:hover {
    color: var(--brand);
  }
  .month-bar-label--picker :global(svg) {
    color: var(--text-2);
  }

  /* Issue #612: a disabled arrow (the period may not pass the current month) must not look
     usable - the global .nav-btn hover tint is suppressed for it. */
  .nav-btn:disabled {
    opacity: 0.5;
    cursor: not-allowed;
  }

  .nav-btn:disabled:hover {
    background: var(--card);
    border-color: var(--line);
    color: var(--text);
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

  .month-bar-zoom {
    display: flex;
    flex: 0 0 auto;
    justify-content: center;
  }

  /* ── Narrow viewports (Issue #553, D-02/D-04/D-05) ────────────────────
     Before this block the nav row (arrow | 200 px centre floor | arrow | "Heute")
     was wider than a 390 px phone: the bar scrolled horizontally
     (423-514 px) or clipped "Heute" at x = 414-428 through
     `.card { overflow: hidden }`. Layout here: arrows and label share one grid
     row, the centre loses its 200 px floor and may shrink, "Heute" and the extra
     slot get their own full-width row. Nothing is hidden or abbreviated.
     Why a grid and not flex-wrap: a measured flex-wrap variant only kept the
     label clear by forcing a 100% basis onto "Heute" (a full-width ghost button),
     and with an auto basis line breaking would push the next arrow, not "Heute",
     onto a new line at narrow widths. The grid always gives the intended outcome.
     Mirrored by .cal-monthbar in app.css (keep both in lockstep).
     These rules come after every base rule they override (same specificity,
     source order decides). The zoom Segment takes a row of its own. */
  @media (max-width: 640px) {
    .month-bar {
      flex-wrap: wrap;
    }

    .month-bar > .month-bar-nav {
      flex: 1 1 100%;
    }

    .month-bar-zoom {
      flex: 1 1 100%;
    }

    .month-bar-nav {
      display: grid;
      grid-template-columns: auto minmax(0, 1fr) auto;
    }

    .month-bar-center {
      min-width: 0;
    }

    .month-bar-today,
    .month-bar-extra {
      grid-column: 1 / -1;
      margin-left: 0;
    }

    /* 44px = the min-height of the neighbouring .nav-btn arrows (app.css), WCAG 2.5.5.
       Scoped (0,2,0) beats the global v1.5 `.btn { min-height: 0 }` (0,1,0). */
    .month-bar-today {
      justify-self: center;
      min-height: 44px;
    }
  }

  /* 26px fits between the arrows from 481 to 640 px (clearance >= 45 px). Below that the
     label is 217 px at 26px and 188 px at 22px, but only ~170 px fit between
     the arrows inside MonatSaldoCard at 360 px (card padding 28 px). 20px (the
     .mini-stat .value size in app.css) is 173 px and clears the arrows by 7 px;
     white-space: nowrap stays (D-02). */
  @media (max-width: 480px) {
    .month-bar-label {
      font-size: 20px;
    }
  }

  /* 320 px (Issue #564): at 20px the label (with the picker chevron, 172 px) was
     wider than the ~146 px between the arrows and overlapped them by up to 13 px. Less side
     padding and an 18px label clear them. Mirrored by .cal-monthbar in app.css. */
  @media (max-width: 360px) {
    .month-bar {
      padding-left: 12px;
      padding-right: 12px;
    }

    .month-bar-label {
      font-size: 18px;
    }
  }
</style>

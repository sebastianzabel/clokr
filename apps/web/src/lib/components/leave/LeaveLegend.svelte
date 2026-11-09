<script lang="ts">
  /**
   * LeaveLegend — Issue #840 (D-840-10, D-840-25). The ONE legend of every absence view.
   *
   * It names only what the view can contain: the given types (by TEXT from the type table, the
   * swatch from `leave-colors.ts` — colour is never the only carrier, WCAG 1.4.1), the given bar
   * styles and the given markings, plus `closedHint` as a sentence when the host passes one. It
   * decides nothing itself: which types and styles occur is the host's answer (`legendFrom()`), and
   * an EMPLOYEE's view simply passes no type codes.
   */
  import { ABSENT, MIXED, leaveTypeColor } from "$lib/leave/leave-colors";
  import { LEAVE_TYPES } from "$lib/leave/team-calendar-visibility";

  type BarStyle = "gesetzt" | "beantragt" | "wunsch" | "abwesend";

  interface Props {
    typeCodes: string[];
    styles: BarStyle[];
    /**
     * `mixed` is the Jahr look of a week with several visible types; a host sets
     * it only when such a week is in view (`hasMixedWeek()`), so the legend never promises it.
     */
    markings?: {
      weekend?: boolean;
      holiday?: boolean;
      closed?: boolean;
      today?: boolean;
      mixed?: boolean;
    };
    /** Sentence for the closed-day marking, or `null`/absent for none. */
    closedHint?: string | null;
    /**
     * How a public holiday is drawn in the host: a tinted band across a timeline column (default)
     * or a tinted calendar cell with a left rule. The swatch follows the host so the legend never
     * promises another look than the view shows.
     */
    holidayLook?: "timeline" | "calendar";
  }

  let {
    typeCodes,
    styles,
    markings = {},
    closedHint = null,
    holidayLook = "timeline",
  }: Props = $props();

  // Display wording only; a style is decided by its code, never by this text.
  const STYLE_LABELS: Record<BarStyle, string> = {
    // #840 G-4: the keys name the look AND the status; "Gesetzt" read as a grey meaning of its own.
    gesetzt: "Genehmigt (voll)",
    beantragt: "Beantragt (gestrichelt)",
    wunsch: "Wunsch (gestreift)",
    abwesend: "Abwesend",
  };

  const MARKING_LABELS = {
    weekend: "Wochenende",
    holiday: "Feiertag",
    closed: "Schließtag",
    today: "Heute",
    mixed: "Mehrere Arten",
  } as const;

  const types = $derived(
    typeCodes.map((code) => ({
      code,
      label: LEAVE_TYPES.find((t) => t.code === code)?.label ?? "Andere Abwesenheit",
      fill: leaveTypeColor(code).fill,
    })),
  );

  // #840 G-4: the voll and gestrichelt keys show the look of a real type, the first one this legend
  // names (brand when it names none) — never a grey of their own that could be read as a meaning.
  const styleFill = $derived(types[0]?.fill ?? "--brand");

  function styleSwatch(style: BarStyle): string | undefined {
    if (style === "abwesend") return `var(${ABSENT.fill})`;
    if (style === "gesetzt" || style === "beantragt") return `var(${styleFill})`;
    return undefined;
  }
</script>

<div class="leave-legend" role="group" aria-label="Legende" data-testid="leave-legend">
  {#each types as type (type.code)}
    <span class="legend-item" data-testid="legend-type-{type.code}"
      ><span class="legend-swatch" style:--swatch="var({type.fill})" aria-hidden="true"
      ></span>{type.label}</span
    >
  {/each}

  {#each styles as style (style)}
    <span class="legend-item" data-testid="legend-style-{style}"
      ><span
        class="legend-swatch legend-swatch--{style}"
        style:--swatch={styleSwatch(style)}
        aria-hidden="true"
      ></span>{STYLE_LABELS[style]}</span
    >
  {/each}

  {#if markings.mixed}
    <span class="legend-item" data-testid="legend-marking-mixed"
      ><span
        class="legend-swatch legend-swatch--mixed"
        style:--swatch="var({MIXED.fill})"
        aria-hidden="true"
      ></span>{MARKING_LABELS.mixed}</span
    >
  {/if}
  {#if markings.weekend}
    <span class="legend-item" data-testid="legend-marking-weekend"
      ><span class="legend-swatch legend-swatch--weekend" aria-hidden="true"
      ></span>{MARKING_LABELS.weekend}</span
    >
  {/if}
  {#if markings.holiday}
    <span class="legend-item" data-testid="legend-marking-holiday"
      ><span class="legend-swatch legend-swatch--holiday-{holidayLook}" aria-hidden="true"
      ></span>{MARKING_LABELS.holiday}</span
    >
  {/if}
  {#if markings.closed}
    <span class="legend-item" data-testid="legend-marking-closed"
      ><span class="legend-swatch legend-swatch--closed" aria-hidden="true"
      ></span>{MARKING_LABELS.closed}</span
    >
  {/if}
  {#if markings.today}
    <span class="legend-item" data-testid="legend-marking-today"
      ><span class="legend-swatch legend-swatch--today" aria-hidden="true"
      ></span>{MARKING_LABELS.today}</span
    >
  {/if}

  {#if closedHint}
    <span class="legend-hint" data-testid="legend-closed-hint">{closedHint}</span>
  {/if}
</div>

<style>
  .leave-legend {
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    gap: 0.5rem 1rem;
    padding: 0.875rem 1.25rem;
  }

  .legend-item {
    display: inline-flex;
    align-items: center;
    gap: 0.3rem;
    font-size: 0.75rem;
    color: var(--text-2);
  }

  .legend-hint {
    font-size: 0.75rem;
    color: var(--text-2);
  }

  .legend-swatch {
    display: inline-block;
    flex-shrink: 0;
    width: 14px;
    height: 10px;
    border-radius: 2px;
    background: var(--swatch, transparent);
  }

  /* Approved: solid fill in the type colour (--swatch). */
  .legend-swatch--gesetzt {
    background: var(--swatch);
  }

  /* Requested: dashed outline on a light tint of the same type colour. */
  .legend-swatch--beantragt {
    background: color-mix(in srgb, var(--swatch) 18%, transparent);
    border: 1.5px dashed var(--swatch);
  }

  /* Wish: diagonal brand stripes with an outline. */
  .legend-swatch--wunsch {
    background:
      repeating-linear-gradient(
        45deg,
        color-mix(in srgb, var(--brand) 30%, transparent) 0,
        color-mix(in srgb, var(--brand) 30%, transparent) 3px,
        transparent 3px,
        transparent 6px
      ),
      var(--brand-soft);
    border: 1.5px solid var(--brand);
  }

  /* Several visible types in a Jahr week: the neutral colour as 135-degree stripes (as in the timeline). */
  .legend-swatch--mixed {
    background:
      repeating-linear-gradient(
        135deg,
        var(--swatch) 0,
        var(--swatch) 3px,
        transparent 3px,
        transparent 6px
      ),
      color-mix(in srgb, var(--swatch) 22%, transparent);
  }

  .legend-swatch--weekend {
    background: var(--weekend-shade);
    border: 1px solid var(--line);
  }

  .legend-swatch--holiday-timeline {
    background: var(--warn-soft);
    border: 1px solid var(--line);
  }

  .legend-swatch--holiday-calendar {
    background: var(--brand-soft);
    border: 1.5px solid var(--brand);
  }

  .legend-swatch--closed {
    background-image: repeating-linear-gradient(
      135deg,
      var(--line) 0,
      var(--line) 1px,
      transparent 1px,
      transparent 4px
    );
    border: 1px solid var(--line);
  }

  .legend-swatch--today {
    width: 14px;
    height: 3px;
    border-radius: 0;
    background: var(--brand);
  }
</style>

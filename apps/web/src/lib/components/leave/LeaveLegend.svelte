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
  import { ABSENT, leaveTypeColor } from "$lib/leave/leave-colors";
  import { LEAVE_TYPES } from "$lib/leave/team-calendar-visibility";

  type BarStyle = "gesetzt" | "beantragt" | "wunsch" | "abwesend";

  interface Props {
    typeCodes: string[];
    styles: BarStyle[];
    markings?: { weekend?: boolean; holiday?: boolean; closed?: boolean; today?: boolean };
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
    gesetzt: "Gesetzt",
    beantragt: "Beantragt (gestrichelt)",
    wunsch: "Wunsch (gestreift)",
    abwesend: "Abwesend",
  };

  const MARKING_LABELS = {
    weekend: "Wochenende",
    holiday: "Feiertag",
    closed: "Schließtag",
    today: "Heute",
  } as const;

  const types = $derived(
    typeCodes.map((code) => ({
      code,
      label: LEAVE_TYPES.find((t) => t.code === code)?.label ?? "Andere Abwesenheit",
      fill: leaveTypeColor(code).fill,
    })),
  );
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
        style:--swatch={style === "abwesend" ? `var(${ABSENT.fill})` : undefined}
        aria-hidden="true"
      ></span>{STYLE_LABELS[style]}</span
    >
  {/each}

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
    color: var(--text-muted);
  }

  .legend-hint {
    font-size: 0.75rem;
    font-style: italic;
    color: var(--text-muted);
  }

  .legend-swatch {
    display: inline-block;
    flex-shrink: 0;
    width: 14px;
    height: 10px;
    border-radius: 2px;
    background: var(--swatch, transparent);
  }

  /* Set: solid fill. */
  .legend-swatch--gesetzt {
    background: var(--text-muted);
  }

  /* Requested: dashed outline on a light tint. */
  .legend-swatch--beantragt {
    background: color-mix(in srgb, var(--text-muted) 18%, transparent);
    border: 1.5px dashed var(--text-muted);
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

  .legend-swatch--weekend {
    background: var(--weekend-shade);
    border: 1px solid var(--border);
  }

  .legend-swatch--holiday-timeline {
    background: var(--warn-soft);
    border: 1px solid var(--border);
  }

  .legend-swatch--holiday-calendar {
    background: var(--brand-soft);
    border: 1.5px solid var(--brand);
  }

  .legend-swatch--closed {
    background-image: repeating-linear-gradient(
      135deg,
      var(--border) 0,
      var(--border) 1px,
      transparent 1px,
      transparent 4px
    );
    border: 1px solid var(--border);
  }

  .legend-swatch--today {
    width: 14px;
    height: 3px;
    border-radius: 0;
    background: var(--brand);
  }
</style>

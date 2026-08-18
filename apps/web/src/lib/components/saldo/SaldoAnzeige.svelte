<script lang="ts">
  // Phase 76-02 — Pure-presentational Überstundensaldo display.
  //
  // Standalone primitive covering the 5 Saldo states:
  //   - 0h (zero)
  //   - positive (e.g. +2:00)
  //   - negative (e.g. −1:30, U+2212 minus)
  //   - locked (Monatsabschluss-Badge co-occurrence)
  //   - no-schedule (saldoMinutes === null → "Kein Stundenplan")
  //
  // Phase 76.7 (D-16, UI-V19-04) — added `exempt` prop. When true, the
  // numeric saldo is replaced with an em-dash "—" (U+2014) so § 18 ArbZG
  // exempt employees (Inhaber/Geschäftsführer/leitende Angestellte) don't
  // see a misleading number. The sign-state collapses to "exempt" → no
  // green/red colour cue. BUrlG vacation tracking is unaffected by this
  // flag (see CONTEXT D-15..D-16).
  //
  // Like CalendarCell, this lives alongside (not replacing) the existing
  // form-context-bound "Überstundensaldo-Info" block in
  // routes/(app)/leave/+page.svelte. See 76-02-SUMMARY.md for context.
  //
  // Phase 97-01 (TRACER, SALDO-DISP-01/03/05) — additive split mode:
  // "Bestätigt" (confirmed carry-over from closed months) vs. "Laufender
  // Monat (Prognose)" (the open month, forecast). Presence of `confirmedMinutes`
  // (!== undefined) switches this component into split rendering; omitting it
  // renders EXACTLY what this component rendered before Phase 97 (byte-identical
  // legacy behaviour — the 13 pre-existing tests + the § 18 exempt behaviour stay
  // green). This is how SALDO-DISP-05 ("one presentation, not three") is
  // satisfied: extending this ONE shared primitive rather than growing a fourth
  // saldo variant elsewhere. See 97-UI-SPEC.md for the full state matrix/copy
  // contract.
  //
  // Phase 97-03 — completes the 97-UI-SPEC state matrix: the toggletip (info
  // icon + keyboard-reachable panel) carrying the one explanation of why the
  // forecast moves, and the "Restmonat unverplant" badge (state C) for a
  // SHIFT_BASED month whose remainder isn't rostered yet. Both render on the
  // forecast block ONLY — the confirmed figure is what this component promises
  // is stable, so it never carries either affordance.
  import Icon from "$components/Icon.svelte";

  export interface SaldoAnzeigeProps {
    saldoMinutes?: number | null;
    isLocked?: boolean;
    variant?: "compact" | "expanded";
    label?: string;
    /** Phase 76.7 (D-16) — § 18 ArbZG-exempt: render "—" instead of saldo number. */
    exempt?: boolean;
    /** Phase 97-01 — confirmed carry-over (closed months), in minutes. Presence of this
     *  prop (!== undefined) switches the component into split rendering. */
    confirmedMinutes?: number;
    /** Open-month forecast, in minutes. `null` = fail-safe/unavailable (renders "—",
     *  suppresses the combined line — a sum of an unknown is not actionable). */
    openMonthMinutes?: number | null;
    /** Whether a closed month exists yet — governs the confirmed=0 caption
     *  ("ausgeglichen" vs. "noch kein Monatsabschluss", UI-SPEC state A2 vs A3). */
    hasClosedMonth?: boolean;
    confirmedLabel?: string;
    forecastLabel?: string;
    combinedLabel?: string;
    /** Phase 97-03 — SHIFT_BASED only: the remaining month has no roster yet (UI-SPEC
     *  state C, "Restmonat unverplant"). The forecast there isn't merely uncertain, it's
     *  known to be biased low (97-CONTEXT "Prognose-Güte"). Renders an always-visible
     *  badge (expanded) / titled dot (compact) on the forecast block only. */
    rosterIncomplete?: boolean;
    /** Phase 97-03 — first-class loading/error states (UI-SPEC F1/F2), short-circuiting
     *  everything else (incl. the lock badge) so a consuming surface can degrade through this
     *  primitive instead of inventing its own skeleton/error markup.
     *  Adoption (IN-01 code-review fix): `loading` is wired on dashboard/+page.svelte,
     *  time-entries/+page.svelte, team/time-entries/+page.svelte, and leave/+page.svelte,
     *  bracketing the same fetch that populates this tile's data on each page. `error` is a
     *  primitive available for a future consumer with a saldo-specific failure signal, but is
     *  NOT currently wired anywhere: every shipped page either fail-safes its overtime fetch to
     *  null (rendering the "no schedule" collapse rather than a hard error) or only has a
     *  generic, page-wide error string that also covers unrelated actions (delete, iCal
     *  export, …) — wiring that in would mislabel an unrelated failure as "saldo failed to
     *  load". reports/+page.svelte's two usages are per-row inside tables that already gate
     *  loading/error at the table level before any row (and thus any instance of this
     *  component) ever mounts, so there is no per-instance state to wire there either. */
    loading?: boolean;
    error?: boolean;
    /** Phase 97-03 — explicit no-WorkSchedule collapse (UI-SPEC E3). Formalises the
     *  pre-existing `saldoMinutes === null` implicit behaviour, which keeps working
     *  unchanged for legacy (non-split) callers that never pass this prop. Not currently wired
     *  by any consuming page (IN-01) — the implicit `saldoMinutes === null` path already covers
     *  every shipped caller; this stays available for a future caller that wants to be explicit. */
    noSchedule?: boolean;
    /** Phase 97-03 — MONTHLY_HOURS with a null/0 monthly target (UI-SPEC E4): a
     *  WorkSchedule genuinely exists, there's just no Soll to compare against. Deliberately
     *  distinct copy from `noSchedule` — reusing "Kein Stundenplan" would misinform. Not
     *  currently wired by any consuming page (IN-01) — no shipped page in this phase
     *  distinguishes "no WorkSchedule" from "MONTHLY_HOURS with no target" at the call site
     *  yet; this stays available for the page that first needs the distinction. */
    noSollTarget?: boolean;
  }

  let {
    saldoMinutes = null,
    isLocked = false,
    variant = "expanded",
    label = "Saldo",
    exempt = false,
    confirmedMinutes = undefined,
    openMonthMinutes = undefined,
    hasClosedMonth = false,
    confirmedLabel = "Bestätigt",
    forecastLabel = "Laufender Monat (Prognose)",
    combinedLabel = "Voraussichtlich gesamt",
    rosterIncomplete = false,
    loading = false,
    error = false,
    noSchedule = false,
    noSollTarget = false,
  }: SaldoAnzeigeProps = $props();

  // Unique DOM id for the toggletip panel — several SaldoAnzeige instances coexist on one
  // page (e.g. /reports), so a fixed literal id would collide. $props.id() is Svelte's
  // SSR/hydration-safe per-instance id generator (must be its own top-level `const`).
  const tooltipUid = $props.id();
  const tooltipId = `saldo-tooltip-${tooltipUid}`;

  // 97-UI-SPEC.md → Tooltip: exact three-sentence German copy, do not reword. The SAME
  // string serves the default case (states B/D) and state C (rosterIncomplete) — the third
  // sentence already names the unfinished-roster case, so there is exactly one tooltip
  // body, never two. Deliberately contains NO §615/Annahmeverzug legal reasoning — that
  // stays on the Überstunden detail page (97-CONTEXT).
  const TOOLTIP_TEXT = `„Bestätigt" ändert sich nur bei Monatsabschluss – der laufende Monat kann diesen Wert nicht senken. Ist der laufende Monat knapp verplant, sinkt die Prognose an gearbeiteten Tagen und gleicht sich zum Monatsende wieder aus. Ist er noch nicht vollständig verplant, bleibt die Prognose zunächst niedrig und springt, sobald der restliche Plan feststeht.`;

  const isSplit = $derived(confirmedMinutes !== undefined);

  // Root sign class — mirrors the template's precedence chain exactly (97-UI-SPEC →
  // Component Contract): loading/error short-circuit everything, then exempt, then the
  // explicit collapse flags, then confirmedMinutes in split mode (so --good/--bad stay
  // reserved for the entitlement figure), then saldoMinutes in legacy mode (unchanged
  // behaviour — an explicit noSchedule=true and the implicit saldoMinutes===null path
  // both resolve to the SAME "no-schedule" sign, so .saldo--no-schedule keeps meaning
  // exactly what the pre-97-03 tests already assert).
  const sign = $derived.by(() => {
    if (loading) return "loading";
    if (error) return "error";
    if (exempt) return "exempt";
    if (noSchedule) return "no-schedule";
    if (noSollTarget) return "no-soll-target";
    if (confirmedMinutes !== undefined) {
      return confirmedMinutes === 0 ? "zero" : confirmedMinutes > 0 ? "positive" : "negative";
    }
    if (saldoMinutes === null) return "no-schedule";
    if (saldoMinutes === 0) return "zero";
    return saldoMinutes > 0 ? "positive" : "negative";
  });

  // Confirmed-figure visual tone (split mode only) — distinct from `sign` because UI-SPEC state
  // A3 (zero + no closed month yet) must render faint, not neutral, even though its sign is "zero".
  const confirmedTone = $derived.by(() => {
    if (confirmedMinutes === undefined) return "";
    if (confirmedMinutes === 0 && !hasClosedMonth) return "faint";
    if (confirmedMinutes > 0) return "good";
    if (confirmedMinutes < 0) return "bad";
    return "neutral";
  });

  // UI-SPEC states A1–A4 — the confirmed figure's caption. Never rendered on the forecast.
  const confirmedCaption = $derived.by(() => {
    if (confirmedMinutes === undefined) return "";
    if (confirmedMinutes > 0) return "Guthaben";
    if (confirmedMinutes < 0) return "offen";
    return hasClosedMonth ? "ausgeglichen" : "noch kein Monatsabschluss";
  });

  // A3 ("noch kein Monatsabschluss") is the one caption UI-SPEC keeps even in compact —
  // misreading 0:00 as a real entitlement is worse than the density cost.
  const isNewHireZero = $derived(confirmedMinutes === 0 && !hasClosedMonth);

  // The forecast is "unavailable" (Task 1's fail-safe shape) when null/undefined — render an
  // en-dash and suppress the combined line entirely.
  const forecastAvailable = $derived(openMonthMinutes !== undefined && openMonthMinutes !== null);

  // Voraussichtlich gesamt — pure display arithmetic over two numbers the API already
  // guarantees reconcile (confirmedMinutes + openMonthMinutes === total, by construction).
  const combinedMinutes = $derived.by(() => {
    if (confirmedMinutes === undefined) return null;
    if (openMonthMinutes === undefined || openMonthMinutes === null) return null;
    return confirmedMinutes + openMonthMinutes;
  });

  const classes = $derived.by(() => {
    const out = ["saldo", `saldo--${sign}`];
    if (isSplit) out.push("saldo--split");
    if (isLocked) out.push("saldo--locked");
    if (variant === "compact") out.push("saldo--compact");
    return out.join(" ");
  });

  function fmt(m: number): string {
    // U+2212 minus sign for negatives (matches CalendarCell delta + v1.5 type recipe).
    const prefix = m > 0 ? "+" : m < 0 ? "−" : "";
    const abs = Math.abs(m);
    const h = Math.floor(abs / 60);
    const min = abs % 60;
    return `${prefix}${h}:${String(min).padStart(2, "0")}`;
  }
</script>

<div class={classes} data-testid="saldo-anzeige">
  {#snippet infoTrigger(iconSize: number)}
    <!-- 97-UI-SPEC → Tooltip trigger mechanics: real button + aria-describedby, panel
         ALWAYS in the DOM, revealed purely by CSS (:hover / :focus-visible / :focus-within
         on the trigger) — no JS state, no role="tooltip". Rendered on the forecast block
         only (never the confirmed block). -->
    <span class="saldo-info-wrap">
      <button
        type="button"
        class="saldo-info-trigger"
        data-testid="saldo-info-trigger"
        aria-describedby={tooltipId}
      >
        <Icon name="info" size={iconSize} title="Warum ändert sich diese Zahl?" />
      </button>
      <div id={tooltipId} class="saldo-tooltip" data-testid="saldo-tooltip">
        {TOOLTIP_TEXT}
      </div>
    </span>
  {/snippet}

  <!-- Code-review fix — the label used to be suppressed entirely in compact mode
       (pre-existing 76-02 behaviour). For split/relabelled callers this label IS the
       only thing distinguishing "Bestätigt" from "Laufender Monat (Prognose)" (e.g.
       the Monat-Saldo tile's "Monat-Saldo (Bestätigt)"/"Monat-Saldo (Prognose)"
       caption) — SALDO-DISP-03 requires that distinction to survive on dense
       surfaces (calendar headers, Berichte table rows) too, not just expanded tiles.
       Already styled at the UI-SPEC "Label" size (12px/--text-muted); see the
       .saldo__label rule below for the accompanying 600-weight fix. -->
  <div class="saldo__label" data-testid="saldo-label">{label}</div>

  {#if loading}
    <!-- UI-SPEC F1 — first-class loading state: skeleton only, no text, sized per variant. -->
    <div
      class="saldo__skeleton skeleton {variant === 'compact' ? 'skeleton-text' : 'skeleton-stat'}"
      data-testid="saldo-skeleton"
    ></div>
  {:else if error}
    <!-- UI-SPEC F2 — matches the established MyWeekView.svelte / MyShiftsWeek.svelte
         error-copy pattern verbatim in structure. -->
    <div class="saldo__error" data-testid="saldo-error">
      <Icon name="alert" size={16} />
      <span>Fehler beim Laden des Saldos. Bitte Seite neu laden.</span>
    </div>
  {:else if exempt}
    <!-- Phase 76.7 (D-16, UI-V19-04) — § 18 ArbZG exempt: em-dash, no number. -->
    <div class="saldo__value" data-testid="saldo-value">—</div>
  {:else if noSchedule}
    <!-- UI-SPEC E3 — explicit no-WorkSchedule collapse. Same copy/testid as the legacy
         saldoMinutes===null branch further below; kept as two branches so the precedence
         chain in code reads identically to 97-UI-SPEC's Component Contract order. -->
    <div class="saldo__value" data-testid="saldo-value">Kein Stundenplan</div>
  {:else if noSollTarget}
    <!-- UI-SPEC E4 — MONTHLY_HOURS with a null/0 monthly target: a WorkSchedule exists,
         there is simply no Soll to compare against. Deliberately NOT "Kein Stundenplan"
         (SALDO-DISP-07) — reusing that copy would misinform the employee. -->
    <div class="saldo__value" data-testid="saldo-value">Keine Soll-Vorgabe</div>
    {#if variant === "expanded"}
      <div class="saldo__subline" data-testid="saldo-no-soll-subline">
        Zeiterfassung ohne Sollvergleich
      </div>
    {/if}
  {:else if isSplit}
    {#if variant === "compact"}
      <!-- UI-SPEC compact: single line — confirmed leads, forecast follows inline in
           parentheses, then the info trigger (still reachable, shrunk to 14px) and the
           state-C dot. Captions/combined line collapse away, EXCEPT the "noch kein
           Monatsabschluss" caption (state A3), which is kept even here. -->
      <div class="saldo__split saldo__split--compact">
        <span
          class="saldo__confirmed-value saldo__confirmed-value--{confirmedTone}"
          data-testid="saldo-confirmed-value"
        >
          {fmt(confirmedMinutes ?? 0)}
        </span>
        <span class="saldo__forecast-value" data-testid="saldo-forecast-value">
          ({forecastAvailable ? fmt(openMonthMinutes ?? 0) : "—"})
        </span>
        {@render infoTrigger(14)}
        {#if rosterIncomplete}
          <!-- Compact state C: 6px dot, never the sole carrier of the meaning — the
               title gives a screen-reader user the full sentence even though a sighted
               compact user only sees a dot (97-UI-SPEC → Compact vs. expanded). -->
          <span class="saldo__roster-dot" data-testid="saldo-roster-badge">
            <Icon name="circle-fill" size={6} title="Restmonat noch nicht vollständig verplant" />
          </span>
        {/if}
        {#if isNewHireZero}
          <span
            class="saldo__confirmed-caption saldo__confirmed-caption--faint"
            data-testid="saldo-confirmed-caption"
          >
            · {confirmedCaption}
          </span>
        {/if}
      </div>
    {:else}
      <!-- UI-SPEC expanded: three-line stack — confirmed (hero), forecast, combined. -->
      <div class="saldo__split">
        <div class="saldo__confirmed">
          <div class="saldo__confirmed-label">{confirmedLabel}</div>
          <div
            class="saldo__confirmed-value saldo__confirmed-value--{confirmedTone}"
            data-testid="saldo-confirmed-value"
          >
            {fmt(confirmedMinutes ?? 0)}
          </div>
          <div
            class="saldo__confirmed-caption"
            class:saldo__confirmed-caption--faint={isNewHireZero}
            data-testid="saldo-confirmed-caption"
          >
            {confirmedCaption}
          </div>
        </div>

        <div class="saldo__forecast">
          <div class="saldo__forecast-label-row">
            <span class="saldo__forecast-label" data-testid="saldo-forecast-label">
              {forecastLabel}
            </span>
            {@render infoTrigger(16)}
          </div>
          <div class="saldo__forecast-value-row">
            <span class="saldo__forecast-value" data-testid="saldo-forecast-value">
              {forecastAvailable ? fmt(openMonthMinutes ?? 0) : "—"}
            </span>
            {#if rosterIncomplete}
              <!-- Expanded state C: always-visible badge — text `--text` (NOT `--warn`,
                   which fails dark-mode contrast on this chip), `--warn` demoted to a
                   small decorative dot only (97-UI-SPEC → Token Contrast Findings). -->
              <span class="saldo__roster-badge" data-testid="saldo-roster-badge">
                <span class="saldo__roster-badge-dot" aria-hidden="true"></span>
                Restmonat unverplant
              </span>
            {/if}
          </div>
        </div>

        {#if combinedMinutes !== null}
          <div class="saldo__combined">
            <span class="saldo__combined-label">{combinedLabel}</span>
            <span class="saldo__combined-value" data-testid="saldo-combined-value"
              >{fmt(combinedMinutes)}</span
            >
          </div>
        {/if}
      </div>
    {/if}
  {:else if saldoMinutes === null}
    <div class="saldo__value" data-testid="saldo-value">Kein Stundenplan</div>
  {:else}
    <div class="saldo__value" data-testid="saldo-value">{fmt(saldoMinutes)}</div>
    {#if rosterIncomplete}
      <!-- WR-02 fix (code review) — the badge is a property of the FIGURE's
           reliability, not of whether a split is being shown: callers that stay in
           legacy single-value mode on purpose (e.g. the Monat-Saldo tile — 97-CONTEXT
           post-research decision 1: relabel, not a split) still need state C. Mirrors
           the split-mode compact dot / expanded badge exactly (same testid, classes,
           copy, Icon) so both render paths stay visually identical. -->
      {#if variant === "compact"}
        <span class="saldo__roster-dot" data-testid="saldo-roster-badge">
          <Icon name="circle-fill" size={6} title="Restmonat noch nicht vollständig verplant" />
        </span>
      {:else}
        <span class="saldo__roster-badge" data-testid="saldo-roster-badge">
          <span class="saldo__roster-badge-dot" aria-hidden="true"></span>
          Restmonat unverplant
        </span>
      {/if}
    {/if}
  {/if}

  {#if isLocked && !loading && !error}
    <!-- 97-UI-SPEC → Assumptions log #3: migrated from the literal 🔒 emoji to the SVG
         Icon grammar (CalendarCell's equivalent badge already uses it); testid + aria-label
         unchanged so the three pre-existing lock tests keep passing unchanged. Suppressed
         during loading/error — we don't know if the month is locked until the data resolves. -->
    <span
      class="saldo__locked-badge"
      data-testid="saldo-locked-badge"
      aria-label="Monat abgeschlossen"
    >
      <Icon name="lock" size={14} />
    </span>
  {/if}
</div>

<style>
  /* Internal element layout only — no token overrides per UI_STYLE_GUIDE.
     The .saldo + .saldo--* sign classes are emitted for global app.css to
     paint sign colors. Tests assert class + text content only; no visual
     regression is expected from missing global rules. */
  .saldo {
    display: inline-flex;
    align-items: baseline;
    gap: 0.5rem;
    font-variant-numeric: tabular-nums;
  }
  .saldo__label {
    /* Code-review fix — now also rendered in compact (see markup above); brought in
       line with the UI-SPEC "Label" typography role (12px/600/1.3) it always
       claimed to use, matching the sibling .saldo__confirmed-label /
       .saldo__forecast-label / .saldo__combined-label rules below. */
    font-size: 12px;
    font-weight: 600;
    line-height: 1.3;
    color: var(--text-muted);
  }
  .saldo__value {
    font-weight: 600;
    font-size: 1rem;
  }
  .saldo__locked-badge {
    opacity: 0.6;
  }
  .saldo--compact .saldo__value {
    font-size: 0.875rem;
  }

  /* ── Phase 97-01 — split rendering (expanded) ─────────────────────────────
     .saldo is display:inline-flex (align-items: baseline); the split root
     switches the whole component to a column stack. */
  .saldo--split {
    display: inline-flex;
    align-items: flex-start;
  }
  .saldo__split {
    display: flex;
    flex-direction: column;
    gap: var(--s-4);
  }

  .saldo__confirmed,
  .saldo__forecast {
    display: flex;
    flex-direction: column;
    gap: var(--s-1);
  }

  .saldo__confirmed-label,
  .saldo__forecast-label,
  .saldo__combined-label {
    font-size: 12px;
    font-weight: 600;
    color: var(--text-muted);
  }

  /* Display-size hero value (expanded confirmed only) — matches the .kpi-value convention. */
  .saldo__confirmed-value {
    font-family: var(--font-serif);
    font-size: 38px;
    font-weight: 400;
    line-height: 1;
    font-variant-numeric: tabular-nums;
  }
  .saldo__confirmed-value--good {
    color: var(--good);
  }
  .saldo__confirmed-value--bad {
    color: var(--bad);
  }
  .saldo__confirmed-value--neutral {
    color: var(--text);
  }
  .saldo__confirmed-value--faint {
    color: var(--text-faint);
  }

  .saldo__confirmed-caption {
    font-size: 12px;
    color: var(--text-muted);
  }
  .saldo__confirmed-caption--faint {
    color: var(--text-faint);
  }

  /* Forecast + combined values are ALWAYS muted, regardless of sign — a locked decision:
     colour must never imply certainty the forecast doesn't have (never --good/--bad/--warn). */
  .saldo__forecast-value {
    font-size: 16px;
    font-weight: 600;
    color: var(--text-muted);
    font-variant-numeric: tabular-nums;
  }

  .saldo__combined {
    display: flex;
    align-items: baseline;
    gap: var(--s-2);
  }
  .saldo__combined-value {
    font-size: 12px;
    font-weight: 600;
    color: var(--text-muted);
    font-variant-numeric: tabular-nums;
  }

  /* ── Phase 97-01 — split rendering (compact) ──────────────────────────────
     Single line: confirmed (Heading size) leads, forecast follows inline in
     parentheses (subordinate size). Captions/combined line collapse away. */
  .saldo__split--compact {
    display: inline-flex;
    align-items: baseline;
    gap: var(--s-1);
    flex-wrap: wrap;
  }
  .saldo__split--compact .saldo__confirmed-value {
    font-family: inherit;
    font-size: 16px;
    font-weight: 600;
    line-height: 1.2;
  }
  .saldo__split--compact .saldo__forecast-value {
    font-size: 12px;
    font-weight: 600;
  }
  .saldo__split--compact .saldo__confirmed-caption {
    font-size: 12px;
  }

  /* ── Phase 97-03 — toggletip trigger + panel ──────────────────────────────
     Always-in-DOM panel per 97-UI-SPEC → Tooltip trigger mechanics: CSS-only
     reveal via :hover / :focus-visible / :focus-within on the trigger, no JS
     state, no role="tooltip" (aria-describedby already exposes the text
     regardless of visual state). The global :focus-visible outline (app.css
     COMP-06) is untouched here — only the panel's opacity/pointer-events are
     toggled, never the trigger's own outline. */
  .saldo-info-wrap {
    position: relative;
    display: inline-flex;
    align-items: center;
  }
  .saldo-info-trigger {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    width: 24px;
    height: 24px;
    padding: 0;
    background: none;
    border: none;
    cursor: pointer;
    color: var(--text-muted);
  }
  .saldo-info-trigger:hover {
    color: var(--text);
  }
  .saldo-tooltip {
    position: absolute;
    top: calc(100% + 6px);
    left: 0;
    z-index: 20;
    width: max-content;
    max-width: 280px;
    padding: var(--s-3) var(--s-4);
    background: var(--bg-elevated);
    border: 1px solid var(--border);
    border-radius: var(--r-md);
    box-shadow: var(--shadow-md);
    font-size: 14px;
    line-height: 1.5;
    color: var(--text);
    opacity: 0;
    pointer-events: none;
    transition: opacity 0.15s ease;
  }
  .saldo-info-trigger:hover ~ .saldo-tooltip,
  .saldo-info-trigger:focus-visible ~ .saldo-tooltip,
  .saldo-info-trigger:focus-within ~ .saldo-tooltip {
    opacity: 1;
    pointer-events: auto;
  }

  /* ── Phase 97-03 — forecast label/value rows (host the trigger + badge) ── */
  .saldo__forecast-label-row {
    display: flex;
    align-items: center;
    gap: var(--s-2);
  }
  .saldo__forecast-value-row {
    display: flex;
    align-items: center;
    gap: var(--s-2);
    flex-wrap: wrap;
  }

  /* ── Phase 97-03 — state C "Restmonat unverplant": text `--text` (not `--warn`,
     which fails dark-mode contrast on this chip), `--warn` demoted to a small
     decorative dot only. Never the sole carrier of the meaning — the badge text,
     the dot, and the tooltip's own third sentence all say it independently. ── */
  .saldo__roster-badge {
    display: inline-flex;
    align-items: center;
    gap: 4px;
    padding: 2px var(--s-2);
    border-radius: 999px;
    background: var(--warn-soft);
    color: var(--text);
    font-size: 12px;
    font-weight: 600;
    white-space: nowrap;
  }
  .saldo__roster-badge-dot {
    width: 6px;
    height: 6px;
    border-radius: 50%;
    background: var(--warn);
    flex-shrink: 0;
  }
  .saldo__roster-dot {
    display: inline-flex;
    align-items: center;
    color: var(--warn);
  }

  /* ── Phase 97-03 — loading (F1) / error (F2) / noSollTarget subline (E4) ──
     Skeleton reuses the app's existing shimmer treatment (app.css); sized per
     variant via a modifier class, never hand-rolled here. */
  .saldo__skeleton {
    display: block;
  }
  .saldo__error {
    display: flex;
    align-items: center;
    gap: var(--s-2);
    color: var(--bad);
    font-size: 14px;
  }
  .saldo__subline {
    font-size: 12px;
    color: var(--text-muted);
  }
</style>

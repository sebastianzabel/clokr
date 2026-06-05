<!--
  ArbZGWarningBar — Phase 76-03

  Pure-presentational component for rendering ArbZG (Arbeitszeitgesetz)
  compliance warnings. Each warning class maps 1:1 to a paragraph in
  CLAUDE.md § ArbZG Rules:

    DAILY_OVER_10   → § 3 ArbZG (10h daily hard cap)
    WEEKLY_OVER_48  → § 3 ArbZG (48h weekly hard cap, Mo-Sa)
    REST_UNDER_11   → § 5 ArbZG (11h rest period)
    BREAK_UNDER_30  → § 4 ArbZG (30min break when >6h work)
    BREAK_UNDER_45  → § 4 ArbZG (45min break when >9h work)

  Renders nothing when warnings array is empty. Preserves input order
  (no implicit sort) so callers can control severity-first ordering.
  CSS classes .modal-arbzg-warnings, .arbzg-warning,
  .arbzg-warning--error, .arbzg-warning--warn are namespaced under
  this component and bound globally so route-level styles in
  app.css still apply when this bar is hoisted into the modal.
-->
<script lang="ts" module>
  export type ArbZGWarningClass =
    | "DAILY_OVER_10"
    | "WEEKLY_OVER_48"
    | "REST_UNDER_11"
    | "BREAK_UNDER_30"
    | "BREAK_UNDER_45";

  export interface ArbZGWarning {
    class: ArbZGWarningClass;
    severity: "error" | "warn";
    /** Optional overshoot/shortfall in minutes — drives the detail line. */
    detailMinutes?: number;
  }

  export interface ArbZGWarningBarProps {
    warnings: ArbZGWarning[];
  }
</script>

<script lang="ts">
  let { warnings }: ArbZGWarningBarProps = $props();

  // ── Message map ──────────────────────────────────────────────
  // German user-facing strings (CLAUDE.md § Language). § references match
  // CLAUDE.md § ArbZG Rules: §3 (daily/weekly max), §4 (breaks), §5 (rest).
  const MESSAGES: Record<ArbZGWarningClass, string> = {
    DAILY_OVER_10: "§ 3 ArbZG: Tagesmaximum von 10 Stunden überschritten",
    WEEKLY_OVER_48: "§ 3 ArbZG: Wochenmaximum von 48 Stunden überschritten",
    REST_UNDER_11: "§ 5 ArbZG: Ruhezeit von 11 Stunden unterschritten",
    BREAK_UNDER_30: "§ 4 ArbZG: Mindestpause von 30 Minuten unterschritten",
    BREAK_UNDER_45: "§ 4 ArbZG: Mindestpause von 45 Minuten unterschritten",
  };

  function detail(w: ArbZGWarning): string | null {
    if (w.detailMinutes === undefined) return null;
    switch (w.class) {
      case "DAILY_OVER_10":
      case "WEEKLY_OVER_48":
        return `${w.detailMinutes} Min. über Maximum`;
      case "REST_UNDER_11":
        return `${w.detailMinutes} Min. fehlende Ruhezeit`;
      case "BREAK_UNDER_30":
      case "BREAK_UNDER_45":
        return `${w.detailMinutes} Min. zu kurz`;
    }
  }
</script>

{#if warnings.length > 0}
  <div class="modal-arbzg-warnings" data-testid="arbzg-warning-bar">
    {#each warnings as warning (warning.class)}
      <div
        class="arbzg-warning arbzg-warning--{warning.severity}"
        data-testid="arbzg-warning"
        data-warning-class={warning.class}
        role="alert"
      >
        <span class="arbzg-warning__message">{MESSAGES[warning.class]}</span>
        {#if detail(warning)}
          <span class="arbzg-warning__detail" data-testid="arbzg-warning-detail">
            {detail(warning)}
          </span>
        {/if}
      </div>
    {/each}
  </div>
{/if}

<style>
  /* .modal-arbzg-warnings + .arbzg-warning + .arbzg-warning--error/--warn are
     global classes already defined in app.css (the team/time-entries route
     uses them inline today). We avoid redefining them here so existing token
     usage stays the single source of truth. */
  .arbzg-warning__message {
    font-weight: 500;
  }
  .arbzg-warning__detail {
    font-size: 0.75rem;
    opacity: 0.8;
    margin-left: 0.5rem;
  }
</style>

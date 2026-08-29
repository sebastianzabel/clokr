<script lang="ts">
  /**
   * KarenzAttestPanel — Phase 113 (GitHub issue #116).
   *
   * The destination explanation that never existed. The dashboard nudge deep-links here, but
   * /leave only ever highlighted a row for 3 s (`leave/+page.svelte:426-439`) next to a
   * non-interactive „Kein Attest" badge — the person was told a document is missing and left
   * without an onward step.
   *
   * There is deliberately NO action in this panel. Clokr has no employee-side submission path
   * at all: PATCH /leave/requests/:id/attest is requireRole("ADMIN","MANAGER")
   * (apps/api/src/routes/leave.ts:2037-2040), LeaveRequest has no documentPath, and the web
   * app's only three file-upload inputs are avatar, CSV import and the manager-side § 9 field.
   * Building one is Stufe 2 and is explicitly excluded from this phase. A control that 403s
   * would be worse than none — so this panel explains instead of pretending.
   *
   * It is also the mobile answer: the „Kein Attest" badge lives in the status column of a
   * nine-column table inside `overflow-x: auto` (`.table-wrapper`, app.css:787) and is
   * off-screen at 384 px — the viewport the issue was reported from. This panel is a normal
   * block element ABOVE the table, so no horizontal scrolling is involved.
   *
   * Scope: the days come from GET /leave/karenz-overrun (12-month, strictly self-scoped
   * window), NOT from the year-filtered, paginated /leave list — see the phase's
   * deferred-items.md for why the two must not be conflated.
   */
  import {
    KARENZ_SUBMISSION_HINT,
    KARENZ_NO_BLOCK_HINT,
    formatKarenzDay,
  } from "$lib/leave/karenz-nudge";

  interface Props {
    /** Count wording from summarizeKarenzOverrun().label, e.g. "2 Tage ohne Attest". */
    label: string;
    /** Distinct, ascending ISO YYYY-MM-DD days from karenzOverrunDays(). */
    days: string[];
  }

  let { label, days }: Props = $props();

  const dayList = $derived(days.map(formatKarenzDay).join(", "));
</script>

{#if days.length > 0}
  <div class="callout karenz-panel" role="status" data-testid="karenz-attest-panel">
    <span class="ico" aria-hidden="true">⚠</span>
    <div class="karenz-body">
      <p><b>{label}</b></p>
      <p>
        Für diese Krankheitstage ist in Clokr kein Attest hinterlegt (§ 5 EFZG):
        <span data-testid="karenz-attest-days">{dayList}</span>
      </p>
      <p>{KARENZ_SUBMISSION_HINT}</p>
      <p>{KARENZ_NO_BLOCK_HINT}</p>
    </div>
  </div>
{/if}

<style>
  /* Colour comes from the global .callout recipe (app.css) — only layout here. */
  .karenz-panel {
    margin-bottom: 1rem;
  }
  .karenz-body {
    display: flex;
    flex-direction: column;
    gap: 0.5rem;
    min-width: 0;
  }
</style>
